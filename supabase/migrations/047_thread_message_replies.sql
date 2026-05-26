-- =============================================
-- Phase 18 — Thread Message Reply Tracking
-- ---------------------------------------------
-- thread_messages (팔로업/회신/전달) 에 대한 회신 감지 및 본문 저장.
--
-- 흐름:
--   1) check-replies cron 이 thread_messages 의 replied=false 행도 폴링
--   2) Gmail threads.get → 발송 이후 + 타인이 보낸 메시지 발견하면 회신
--   3) thread_message_replies 에 본문/메타 저장 + thread_messages.replied=true
--   4) UI 에서 "회신 받음" 배지 + 모달에서 회신 본문 표시
--   5) 사용자는 그 회신에 다시 회신 가능 → 또 thread_messages 새 row 가 생성됨 (mode='reply', threadId 유지)
-- =============================================

-- 1) thread_messages 에 회신 추적 컬럼
ALTER TABLE mailcaster.thread_messages
  ADD COLUMN IF NOT EXISTS replied             BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS replied_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reply_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_count         INTEGER     NOT NULL DEFAULT 0;

-- cron 큐 인덱스 — "발송 완료 + thread 있고 + 아직 미회신" 행만 대상
CREATE INDEX IF NOT EXISTS idx_thread_messages_reply_check
  ON mailcaster.thread_messages (last_reply_check_at NULLS FIRST)
  WHERE status = 'sent' AND gmail_thread_id IS NOT NULL AND replied = FALSE;

-- 2) thread_message_replies — 수신된 회신 본문/메타 저장
-- 한 thread_message 가 여러 회신을 받을 수 있음 (대화가 계속될 수 있음).
-- 동일 Gmail message id 중복 INSERT 방지 위해 UNIQUE.
CREATE TABLE IF NOT EXISTS mailcaster.thread_message_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_message_id UUID NOT NULL REFERENCES mailcaster.thread_messages(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,

  -- Gmail 메타
  gmail_message_id TEXT NOT NULL,           -- 회신 메시지의 Gmail 내부 id
  gmail_thread_id TEXT,                     -- 같은 thread (thread_messages.gmail_thread_id 와 동일)
  rfc_message_id TEXT,                      -- RFC 2822 Message-ID 헤더 — 다시 회신 시 In-Reply-To 에 쓸 수 있음

  -- 회신 내용
  from_email TEXT,
  from_name TEXT,
  subject TEXT,
  snippet TEXT,                             -- Gmail snippet (preview)
  body_text TEXT,                           -- text/plain (잘릴 수 있음 — 2KB 컷)

  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (thread_message_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_message_replies_msg
  ON mailcaster.thread_message_replies (thread_message_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_thread_message_replies_org
  ON mailcaster.thread_message_replies (org_id, received_at DESC);

-- RLS — 조직 멤버는 SELECT, INSERT 는 service_role (edge function) 만
ALTER TABLE mailcaster.thread_message_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tmr_select_org" ON mailcaster.thread_message_replies;
CREATE POLICY "tmr_select_org"
  ON mailcaster.thread_message_replies FOR SELECT
  TO authenticated
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

GRANT SELECT ON mailcaster.thread_message_replies TO authenticated;
GRANT SELECT, INSERT ON mailcaster.thread_message_replies TO service_role;

COMMENT ON TABLE mailcaster.thread_message_replies IS
  '팔로업/회신/전달 메일 (thread_messages) 에 대해 받은 회신의 본문/메타. cron 이 INSERT.';

-- 3) RPC — thread message 회신 기록 (race-safe)
-- ON CONFLICT DO NOTHING + RETURNING 으로 "이번 호출이 첫 신규 회신인가" 판정.
-- 첫 회신이면 thread_messages.replied=true 마킹 + reply_count 증가.
CREATE OR REPLACE FUNCTION mailcaster.record_thread_reply(
  p_thread_message_id UUID,
  p_org_id            UUID,
  p_gmail_message_id  TEXT,
  p_gmail_thread_id   TEXT,
  p_rfc_message_id    TEXT,
  p_from_email        TEXT,
  p_from_name         TEXT,
  p_subject           TEXT,
  p_snippet           TEXT,
  p_body_text         TEXT,
  p_received_at       TIMESTAMPTZ
)
RETURNS BOOLEAN  -- TRUE = 첫 회신 (replied 마킹 됨), FALSE = 중복/no-op
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_inserted_id UUID;
BEGIN
  INSERT INTO mailcaster.thread_message_replies (
    thread_message_id, org_id,
    gmail_message_id, gmail_thread_id, rfc_message_id,
    from_email, from_name, subject, snippet, body_text,
    received_at
  ) VALUES (
    p_thread_message_id, p_org_id,
    p_gmail_message_id, p_gmail_thread_id, p_rfc_message_id,
    p_from_email, p_from_name, p_subject, p_snippet, p_body_text,
    COALESCE(p_received_at, NOW())
  )
  ON CONFLICT (thread_message_id, gmail_message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    -- 이미 같은 회신이 기록돼 있음 — no-op
    RETURN FALSE;
  END IF;

  -- 새 회신 — thread_messages 갱신 (replied 마킹은 1회만, count 는 항상 +1)
  UPDATE mailcaster.thread_messages
     SET replied      = TRUE,
         replied_at   = COALESCE(replied_at, COALESCE(p_received_at, NOW())),
         reply_count  = COALESCE(reply_count, 0) + 1
   WHERE id = p_thread_message_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.record_thread_reply(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.record_thread_reply(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION mailcaster.record_thread_reply(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) IS
  'check-replies cron 이 thread message 회신 감지 시 호출. 중복 INSERT 방지 + 첫 회신만 replied 마킹.';
