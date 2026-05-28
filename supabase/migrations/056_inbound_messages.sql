-- =============================================
-- Phase 19 — Inbound Mail Tracking
-- ---------------------------------------------
-- Contact 가 우리에게 먼저 보낸 메일 (cold inbound) 을 MailCaster 안에서 추적.
-- 캠페인 발송 → 회신 흐름 (thread_messages_replies) 과 별개로, 우리가 발송 안 한
-- thread 도 잡아서 ContactDetailSheet 의 메일 히스토리에 표시.
--
-- 폴링:
--   check-inbox cron 이 매 5분 사용자의 Gmail "list?q=in:inbox" 를 호출.
--   - From 헤더가 contacts.email 과 매칭되면 기록.
--   - 매칭 없으면 새 contact 자동 생성 (group='inbound') 후 기록.
--
-- 회신:
--   ThreadComposeDialog 의 reply 모드 재사용. threadId = inbound.gmail_thread_id.
-- =============================================

-- 1) inbound_messages 테이블
CREATE TABLE IF NOT EXISTS mailcaster.inbound_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE SET NULL,

  -- 어느 contact 가 보냈는지. 매칭/생성된 contact.
  contact_id UUID REFERENCES mailcaster.contacts(id) ON DELETE SET NULL,

  -- Gmail 메타
  gmail_message_id TEXT NOT NULL,            -- Gmail 내부 message id
  gmail_thread_id TEXT,                      -- 같은 thread 의 다른 inbound 와 묶임
  rfc_message_id TEXT,                       -- RFC 2822 Message-ID — 우리가 회신 시 In-Reply-To 헤더로 사용

  -- 본문 / 메타
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_emails TEXT[] DEFAULT '{}',             -- To 헤더의 이메일들 (CC 인지 직접 To 인지 구분용)
  subject TEXT,
  snippet TEXT,                              -- Gmail snippet (preview)
  body_text TEXT,                            -- text/plain (stripQuoteForStorage 적용)
  body_html TEXT,                            -- HTML (선택)

  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_org_recent
  ON mailcaster.inbound_messages (org_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_contact
  ON mailcaster.inbound_messages (contact_id, received_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_messages_thread
  ON mailcaster.inbound_messages (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

-- RLS: 조직 멤버는 SELECT, INSERT 는 service_role 만 (check-inbox cron 이 호출)
ALTER TABLE mailcaster.inbound_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inbound_messages_select_org" ON mailcaster.inbound_messages;
CREATE POLICY "inbound_messages_select_org"
  ON mailcaster.inbound_messages FOR SELECT
  TO authenticated
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

GRANT SELECT ON mailcaster.inbound_messages TO authenticated;
GRANT SELECT, INSERT ON mailcaster.inbound_messages TO service_role;

COMMENT ON TABLE mailcaster.inbound_messages IS
  'Contact 로부터 받은 inbound 메일 (우리가 먼저 보내지 않은). check-inbox cron 이 INSERT.';

-- 2) profile 의 last_inbox_check_at — incremental 폴링 cursor.
-- 각 사용자별 "마지막 inbox 체크 시각" 을 cron 이 갱신, 그 이후 도착한 메일만 폴링.
ALTER TABLE mailcaster.profiles
  ADD COLUMN IF NOT EXISTS last_inbox_check_at TIMESTAMPTZ;

COMMENT ON COLUMN mailcaster.profiles.last_inbox_check_at IS
  'check-inbox cron 의 incremental cursor — 이 시점 이후 도착한 inbox 메일만 폴링.';

-- 3) RPC — inbound 메일 기록 + contact 자동 생성 (race-safe)
-- check-inbox edge function 이 호출. service_role 전용.
CREATE OR REPLACE FUNCTION mailcaster.record_inbound_message(
  p_org_id            UUID,
  p_user_id           UUID,
  p_gmail_message_id  TEXT,
  p_gmail_thread_id   TEXT,
  p_rfc_message_id    TEXT,
  p_from_email        TEXT,
  p_from_name         TEXT,
  p_to_emails         TEXT[],
  p_subject           TEXT,
  p_snippet           TEXT,
  p_body_text         TEXT,
  p_body_html         TEXT,
  p_received_at       TIMESTAMPTZ,
  p_auto_create_contact BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (inserted BOOLEAN, contact_id UUID, contact_created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_contact_id     UUID;
  v_contact_created BOOLEAN := FALSE;
  v_inserted_id    UUID;
  v_normalized_email TEXT;
BEGIN
  IF p_from_email IS NULL OR p_gmail_message_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, FALSE;
    RETURN;
  END IF;

  v_normalized_email := LOWER(TRIM(p_from_email));

  -- 1) 같은 org 에서 from_email 매칭되는 contact 찾기
  SELECT id INTO v_contact_id
    FROM mailcaster.contacts
   WHERE org_id = p_org_id
     AND LOWER(email) = v_normalized_email
   LIMIT 1;

  -- 2) 매칭 없으면 자동 생성 (p_auto_create_contact = TRUE 일 때)
  IF v_contact_id IS NULL AND p_auto_create_contact THEN
    INSERT INTO mailcaster.contacts (
      org_id, user_id, email, name, memo
    ) VALUES (
      p_org_id,
      p_user_id,
      v_normalized_email,
      NULLIF(TRIM(COALESCE(p_from_name, '')), ''),
      'Gmail inbound 자동 생성 (' || to_char(NOW(), 'YYYY-MM-DD') || ')'
    )
    ON CONFLICT (user_id, email) DO UPDATE
      SET updated_at = NOW()  -- 동시 실행 race-safe (이미 있으면 그대로)
    RETURNING id INTO v_contact_id;
    v_contact_created := TRUE;
  END IF;

  -- 3) inbound_messages INSERT — UNIQUE (org_id, gmail_message_id) 로 중복 차단
  INSERT INTO mailcaster.inbound_messages (
    org_id, user_id, contact_id,
    gmail_message_id, gmail_thread_id, rfc_message_id,
    from_email, from_name, to_emails, subject, snippet, body_text, body_html,
    received_at
  ) VALUES (
    p_org_id, p_user_id, v_contact_id,
    p_gmail_message_id, p_gmail_thread_id, p_rfc_message_id,
    v_normalized_email,
    NULLIF(TRIM(COALESCE(p_from_name, '')), ''),
    COALESCE(p_to_emails, '{}'::TEXT[]),
    p_subject, p_snippet, p_body_text, p_body_html,
    COALESCE(p_received_at, NOW())
  )
  ON CONFLICT (org_id, gmail_message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  RETURN QUERY SELECT (v_inserted_id IS NOT NULL), v_contact_id, v_contact_created;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.record_inbound_message(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.record_inbound_message(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN) TO service_role;

COMMENT ON FUNCTION mailcaster.record_inbound_message IS
  'check-inbox cron 이 inbound 메일 기록 시 호출. contact 매칭 + 필요시 자동 생성 + 중복 차단.';

-- 4) check-inbox cron — 매 5분 (check-replies 와 동일 vault 패턴)
DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-check-inbox') THEN
    PERFORM cron.unschedule('mailcaster-check-inbox');
  END IF;
END
$unsched$;

SELECT cron.schedule(
  'mailcaster-check-inbox',
  '*/5 * * * *',
  $cronbody$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
          FROM vault.decrypted_secrets
         WHERE name = 'mailcaster_project_url'
      ) || '/functions/v1/check-inbox',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
            FROM vault.decrypted_secrets
           WHERE name = 'mailcaster_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $cronbody$
);
