-- =============================================
-- Phase 16 — Thread Messages
-- ---------------------------------------------
-- 메일캐스터에서 보낸/받은 메일에 대한 후속 액션 (팔로업 / 회신 / 전달) 추적.
-- 기존 campaigns / recipients 는 "캠페인 1회 발송" 단위. thread_messages 는
-- 이미 발송된 메일을 둘러싼 추가 1:1 메일 (영업 follow-up 의 일상).
--
-- 흐름:
--   1) 캠페인 detail 또는 contact timeline 에서 "팔로업/회신/전달" 클릭
--   2) ThreadComposeDialog 가 열림 → 사용자 작성
--   3) Gmail API 로 발송 (followup/reply 는 같은 thread_id, forward 는 new thread)
--   4) 결과를 이 테이블에 기록 → 통계/감사용
--
-- 추적:
--   - replied / opened 등 후속 통계는 추후 (Phase 17) 별도 cron 이 갱신.
--     이 테이블은 발송 결과 (sent/failed) 만 우선 기록.
-- =============================================

CREATE TABLE IF NOT EXISTS mailcaster.thread_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES mailcaster.profiles(id) ON DELETE SET NULL,

  -- 어느 캠페인 / 수신자 / 연락처와 연관됐는지. NULL 가능 — orphan follow-up.
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE SET NULL,
  recipient_id UUID REFERENCES mailcaster.recipients(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES mailcaster.contacts(id) ON DELETE SET NULL,

  -- 액션 종류
  mode TEXT NOT NULL CHECK (mode IN ('followup', 'reply', 'forward')),

  -- 메일 내용
  to_email TEXT NOT NULL,
  to_name TEXT,
  cc TEXT[] DEFAULT '{}',
  bcc TEXT[] DEFAULT '{}',
  subject TEXT,
  body_html TEXT,

  -- Gmail 추적
  gmail_thread_id TEXT,          -- 같은 thread 이면 followup/reply, NULL 또는 새 id 면 forward
  gmail_message_id TEXT,         -- 발송 성공 시 채워짐
  in_reply_to_message_id TEXT,   -- In-Reply-To 헤더에 들어간 원본 메시지 id

  -- 상태
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_org_recent
  ON mailcaster.thread_messages (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_thread_messages_recipient
  ON mailcaster.thread_messages (recipient_id)
  WHERE recipient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thread_messages_contact
  ON mailcaster.thread_messages (contact_id)
  WHERE contact_id IS NOT NULL;

-- RLS
ALTER TABLE mailcaster.thread_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "thread_messages_select_org" ON mailcaster.thread_messages;
CREATE POLICY "thread_messages_select_org"
  ON mailcaster.thread_messages FOR SELECT
  TO authenticated
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

DROP POLICY IF EXISTS "thread_messages_insert_own" ON mailcaster.thread_messages;
CREATE POLICY "thread_messages_insert_own"
  ON mailcaster.thread_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

DROP POLICY IF EXISTS "thread_messages_update_own" ON mailcaster.thread_messages;
CREATE POLICY "thread_messages_update_own"
  ON mailcaster.thread_messages FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE ON mailcaster.thread_messages
  TO authenticated, service_role;

COMMENT ON TABLE mailcaster.thread_messages IS
  '캠페인 발송 후 1:1 후속 메일 (팔로업/회신/전달) 추적. recipients 와 별개.';
