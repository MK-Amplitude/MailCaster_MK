-- =============================================
-- MailCaster Phase 1 — Full DB Schema
-- 전용 스키마(mailcaster) 기반. 공통 Supabase 프로젝트에서 격리 운영.
-- =============================================

-- pgcrypto for token encryption
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================
-- 0. 전용 스키마 생성 및 권한
-- =============================================
CREATE SCHEMA IF NOT EXISTS mailcaster;

GRANT USAGE ON SCHEMA mailcaster TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mailcaster
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mailcaster
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mailcaster
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- =============================================
-- 1. 사용자 프로필
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  google_access_token TEXT,
  google_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  signature_html TEXT,
  default_sender_name TEXT,
  default_cc TEXT,
  default_bcc TEXT,
  slack_webhook_url TEXT,
  slack_channel_name TEXT,
  daily_send_count INT DEFAULT 0,
  daily_send_count_date DATE,
  daily_send_limit INT DEFAULT 1500,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 2. 연락처
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  company TEXT,
  department TEXT,
  job_title TEXT,
  phone TEXT,
  timezone TEXT,
  memo TEXT,
  variables JSONB DEFAULT '{}',
  is_unsubscribed BOOLEAN DEFAULT false,
  unsubscribed_at TIMESTAMPTZ,
  is_bounced BOOLEAN DEFAULT false,
  bounce_count INT DEFAULT 0,
  last_bounced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, email)
);

-- =============================================
-- 3. 수신거부 / 블랙리스트
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.unsubscribes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  reason TEXT,
  source_campaign_id UUID,
  unsubscribed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, email)
);

CREATE TABLE IF NOT EXISTS mailcaster.blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, email)
);

-- =============================================
-- 4. 그룹 카테고리
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.group_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  icon TEXT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, name)
);

-- =============================================
-- 5. 그룹
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  category_id UUID REFERENCES mailcaster.group_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  member_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 6. 연락처 ↔ 그룹 매핑 (다대다)
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.contact_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES mailcaster.contacts(id) ON DELETE CASCADE NOT NULL,
  group_id UUID REFERENCES mailcaster.groups(id) ON DELETE CASCADE NOT NULL,
  added_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(contact_id, group_id)
);

-- =============================================
-- 7. 이메일 템플릿
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  variables TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 8. 서명
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  html TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 9. 캠페인
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  template_id UUID REFERENCES mailcaster.templates(id) ON DELETE SET NULL,
  signature_id UUID REFERENCES mailcaster.signatures(id) ON DELETE SET NULL,
  subject TEXT,
  body_html TEXT,
  status TEXT DEFAULT 'draft',
  total_count INT DEFAULT 0,
  sent_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  open_count INT DEFAULT 0,
  reply_count INT DEFAULT 0,
  unsubscribe_count INT DEFAULT 0,
  bounce_count INT DEFAULT 0,
  send_delay_seconds INT DEFAULT 2,
  include_unsubscribe_link BOOLEAN DEFAULT true,
  enable_open_tracking BOOLEAN DEFAULT true,
  draft_data JSONB,
  last_saved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  scheduled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mailcaster.campaign_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  group_id UUID REFERENCES mailcaster.groups(id) ON DELETE CASCADE NOT NULL,
  UNIQUE(campaign_id, group_id)
);

-- =============================================
-- 10. 수신자
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  contact_id UUID REFERENCES mailcaster.contacts(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  name TEXT,
  variables JSONB DEFAULT '{}',
  scheduled_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  opened BOOLEAN DEFAULT false,
  opened_at TIMESTAMPTZ,
  open_count INT DEFAULT 0,
  replied BOOLEAN DEFAULT false,
  replied_at TIMESTAMPTZ,
  bounced BOOLEAN DEFAULT false,
  bounced_at TIMESTAMPTZ,
  followup_stage INT DEFAULT 0,
  next_followup_at TIMESTAMPTZ,
  followup_stopped BOOLEAN DEFAULT false,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 11. 팔로업 시퀀스
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.followup_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  step_number INT NOT NULL,
  delay_days INT NOT NULL,
  subject TEXT,
  body_html TEXT NOT NULL,
  send_if TEXT DEFAULT 'no_reply',
  stop_if TEXT DEFAULT 'replied',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(campaign_id, step_number)
);

CREATE TABLE IF NOT EXISTS mailcaster.followup_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID REFERENCES mailcaster.recipients(id) ON DELETE CASCADE NOT NULL,
  followup_step_id UUID REFERENCES mailcaster.followup_steps(id),
  step_number INT,
  status TEXT,
  gmail_message_id TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 12. 오픈 추적
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.open_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID REFERENCES mailcaster.recipients(id) ON DELETE CASCADE NOT NULL,
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  opened_at TIMESTAMPTZ DEFAULT now(),
  user_agent TEXT
);

-- =============================================
-- 13. 첨부파일
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  file_name TEXT NOT NULL,
  file_size INT,
  mime_type TEXT,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 14. 발송 로그
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.send_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID REFERENCES mailcaster.recipients(id),
  campaign_id UUID REFERENCES mailcaster.campaigns(id),
  log_type TEXT DEFAULT 'send',
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  status TEXT,
  error_detail TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 15. Slack 알림 로그
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.slack_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE CASCADE NOT NULL,
  campaign_id UUID REFERENCES mailcaster.campaigns(id),
  event_type TEXT,
  message TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 트리거: 신규 유저 프로필 자동 생성
-- auth.users 는 public 영역이지만 결과는 mailcaster.profiles 로 저장
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO mailcaster.profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = mailcaster, public;

DROP TRIGGER IF EXISTS on_auth_user_created_mailcaster ON auth.users;
CREATE TRIGGER on_auth_user_created_mailcaster
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION mailcaster.handle_new_user();

-- =============================================
-- 트리거: 그룹 멤버 수 자동 갱신
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.update_group_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE mailcaster.groups SET member_count = member_count + 1, updated_at = now()
    WHERE id = NEW.group_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE mailcaster.groups SET member_count = GREATEST(member_count - 1, 0), updated_at = now()
    WHERE id = OLD.group_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contact_groups_count ON mailcaster.contact_groups;
CREATE TRIGGER trg_contact_groups_count
  AFTER INSERT OR DELETE ON mailcaster.contact_groups
  FOR EACH ROW EXECUTE FUNCTION mailcaster.update_group_member_count();

-- =============================================
-- 트리거: 기본 서명 단일 유지
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.enforce_single_default_signature()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_default = true THEN
    UPDATE mailcaster.signatures
    SET is_default = false
    WHERE user_id = NEW.user_id AND id != NEW.id AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_signature_default ON mailcaster.signatures;
CREATE TRIGGER trg_signature_default
  AFTER INSERT OR UPDATE ON mailcaster.signatures
  FOR EACH ROW EXECUTE FUNCTION mailcaster.enforce_single_default_signature();

-- =============================================
-- 트리거: updated_at 자동 갱신
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contacts_updated_at ON mailcaster.contacts;
CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON mailcaster.contacts
  FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();

DROP TRIGGER IF EXISTS trg_groups_updated_at ON mailcaster.groups;
CREATE TRIGGER trg_groups_updated_at
  BEFORE UPDATE ON mailcaster.groups
  FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();

DROP TRIGGER IF EXISTS trg_templates_updated_at ON mailcaster.templates;
CREATE TRIGGER trg_templates_updated_at
  BEFORE UPDATE ON mailcaster.templates
  FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();

DROP TRIGGER IF EXISTS trg_signatures_updated_at ON mailcaster.signatures;
CREATE TRIGGER trg_signatures_updated_at
  BEFORE UPDATE ON mailcaster.signatures
  FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();

-- =============================================
-- RLS 활성화
-- =============================================
ALTER TABLE mailcaster.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.unsubscribes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.blacklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.group_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.contact_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.campaign_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.followup_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.followup_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.open_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.send_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.slack_notifications ENABLE ROW LEVEL SECURITY;

-- =============================================
-- RLS 정책
-- =============================================
CREATE POLICY "profiles: own" ON mailcaster.profiles
  USING (id = auth.uid());

CREATE POLICY "contacts: own" ON mailcaster.contacts
  USING (user_id = auth.uid());

CREATE POLICY "unsubscribes: own" ON mailcaster.unsubscribes
  USING (user_id = auth.uid());

CREATE POLICY "blacklist: own" ON mailcaster.blacklist
  USING (user_id = auth.uid());

CREATE POLICY "group_categories: own" ON mailcaster.group_categories
  USING (user_id = auth.uid());

CREATE POLICY "groups: own" ON mailcaster.groups
  USING (user_id = auth.uid());

CREATE POLICY "contact_groups: own" ON mailcaster.contact_groups
  USING (
    contact_id IN (SELECT id FROM mailcaster.contacts WHERE user_id = auth.uid())
  );

CREATE POLICY "templates: own" ON mailcaster.templates
  USING (user_id = auth.uid());

CREATE POLICY "signatures: own" ON mailcaster.signatures
  USING (user_id = auth.uid());

CREATE POLICY "campaigns: own" ON mailcaster.campaigns
  USING (user_id = auth.uid());

CREATE POLICY "campaign_groups: own" ON mailcaster.campaign_groups
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "recipients: own" ON mailcaster.recipients
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "followup_steps: own" ON mailcaster.followup_steps
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "followup_logs: own" ON mailcaster.followup_logs
  USING (
    recipient_id IN (
      SELECT r.id FROM mailcaster.recipients r
      JOIN mailcaster.campaigns c ON r.campaign_id = c.id
      WHERE c.user_id = auth.uid()
    )
  );

CREATE POLICY "open_events: own" ON mailcaster.open_events
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "attachments: own" ON mailcaster.attachments
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "send_logs: own" ON mailcaster.send_logs
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "slack_notifications: own" ON mailcaster.slack_notifications
  USING (user_id = auth.uid());

-- =============================================
-- 유용한 뷰 (security_invoker=true 로 호출자 RLS 적용)
-- =============================================

CREATE OR REPLACE VIEW mailcaster.contact_with_groups
WITH (security_invoker = true) AS
SELECT
  c.*,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'group_id', g.id,
        'group_name', g.name,
        'category_id', gc.id,
        'category_name', gc.name,
        'category_color', gc.color
      )
    ) FILTER (WHERE g.id IS NOT NULL),
    '[]'::jsonb
  ) AS groups
FROM mailcaster.contacts c
LEFT JOIN mailcaster.contact_groups cg ON c.id = cg.contact_id
LEFT JOIN mailcaster.groups g ON cg.group_id = g.id
LEFT JOIN mailcaster.group_categories gc ON g.category_id = gc.id
GROUP BY c.id;

CREATE OR REPLACE VIEW mailcaster.campaign_stats
WITH (security_invoker = true) AS
SELECT
  c.id,
  c.name,
  c.status,
  c.total_count,
  c.sent_count,
  c.failed_count,
  c.open_count,
  c.reply_count,
  c.bounce_count,
  c.unsubscribe_count,
  CASE WHEN c.sent_count > 0 THEN ROUND(c.open_count::numeric / c.sent_count * 100, 1) ELSE 0 END AS open_rate,
  CASE WHEN c.sent_count > 0 THEN ROUND(c.reply_count::numeric / c.sent_count * 100, 1) ELSE 0 END AS reply_rate,
  c.created_at,
  c.scheduled_at
FROM mailcaster.campaigns c;

-- =============================================
-- 기존 객체에 대한 권한 부여 (이미 생성된 테이블/뷰/시퀀스/함수)
-- =============================================
GRANT ALL ON ALL TABLES IN SCHEMA mailcaster TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mailcaster TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA mailcaster TO anon, authenticated, service_role;
