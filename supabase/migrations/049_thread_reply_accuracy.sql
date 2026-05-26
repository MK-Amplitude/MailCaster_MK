-- =============================================
-- Phase 18.2 — Thread Reply 정확도 / 중복 저장 차단
-- ---------------------------------------------
-- 2차 감사에서 발견된 결함:
--   A) UNIQUE (thread_message_id, gmail_message_id) 라서, 같은 Gmail thread 에
--      여러 thread_message 가 있을 때 같은 회신이 양쪽에 각각 INSERT 됨 → 통계 부풀림
--   H) record_thread_reply 가 p_org_id 검증 안 함 — 잘못된 호출 시 RLS 가 영원히 숨김
--
-- 수정:
--   1. UNIQUE 를 (org_id, gmail_message_id) 로 변경 → 한 회신은 org 안에서 한 번만
--   2. record_thread_reply 에 org_id 일치 검증 + 다중 회신 정확 매핑 로직
--
-- 주의: 047 INSERT 후 일부 row 가 이미 들어가 있을 수 있으나, 새 cron 코드는
--       In-Reply-To 매칭으로 단 하나의 thread_message 에만 매핑하므로 신규 데이터는 안전.
--       기존 잘못 저장된 중복 행은 이 마이그레이션에서 정리 (SELECT DISTINCT ON).
-- =============================================

-- 1) 기존 중복 row 제거 — 같은 (org_id, gmail_message_id) 가 여러 row 인 경우
--    가장 이른 received_at 한 건만 남김 (가장 정확한 매핑 가정).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY org_id, gmail_message_id
           ORDER BY received_at ASC, created_at ASC
         ) AS rn
    FROM mailcaster.thread_message_replies
)
DELETE FROM mailcaster.thread_message_replies
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2) 기존 UNIQUE 제거 + 새 UNIQUE 추가
ALTER TABLE mailcaster.thread_message_replies
  DROP CONSTRAINT IF EXISTS thread_message_replies_thread_message_id_gmail_message_id_key;

ALTER TABLE mailcaster.thread_message_replies
  ADD CONSTRAINT thread_message_replies_org_gmail_unique
    UNIQUE (org_id, gmail_message_id);

COMMENT ON CONSTRAINT thread_message_replies_org_gmail_unique
  ON mailcaster.thread_message_replies IS
  '같은 회신 메시지는 org 안에서 한 번만 저장 — 같은 Gmail thread 에 여러 thread_message 가 있어도 중복 INSERT 차단.';

-- 3) thread_messages 의 reply_count 가 부풀려져 있을 수 있으므로 재계산
UPDATE mailcaster.thread_messages tm
   SET reply_count = COALESCE(sub.cnt, 0),
       replied = COALESCE(sub.cnt, 0) > 0,
       replied_at = sub.first_received_at  -- 첫 회신 시각으로 재설정
  FROM (
    SELECT thread_message_id,
           COUNT(*) AS cnt,
           MIN(received_at) AS first_received_at
      FROM mailcaster.thread_message_replies
     GROUP BY thread_message_id
  ) sub
 WHERE tm.id = sub.thread_message_id;

-- 4) record_thread_reply RPC 재작성 — org_id 검증 + defensive
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
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_inserted_id UUID;
  v_tm_org_id   UUID;
BEGIN
  -- defensive: p_org_id 가 실제 thread_message 의 org_id 와 일치하는지 검증
  -- 불일치 시 RLS 로 영원히 안 보이는 row 가 생기는 사고 방지.
  SELECT org_id INTO v_tm_org_id
    FROM mailcaster.thread_messages
   WHERE id = p_thread_message_id;

  IF v_tm_org_id IS NULL THEN
    -- thread_message 가 없음 — 픽셀처럼 silent fail
    RETURN FALSE;
  END IF;

  IF v_tm_org_id <> p_org_id THEN
    RAISE EXCEPTION 'record_thread_reply: org_id mismatch (tm.org_id=% vs p_org_id=%)',
      v_tm_org_id, p_org_id;
  END IF;

  -- INSERT — UNIQUE (org_id, gmail_message_id) 에 충돌하면 (다른 tm 이 이미 저장)
  -- DO NOTHING 으로 skip. 첫 INSERT 만 RETURNING.
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
  ON CONFLICT (org_id, gmail_message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN FALSE;  -- 다른 tm 이 이미 저장한 회신 — 중복 카운터 증가 막음
  END IF;

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
  'check-replies cron 이 thread message 회신 감지 시 호출. org_id 검증 + (org_id, gmail_message_id) UNIQUE 로 중복 차단.';
