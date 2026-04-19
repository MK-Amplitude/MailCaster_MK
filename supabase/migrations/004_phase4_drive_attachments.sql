-- =============================================
-- Phase 4: Google Drive 첨부 파일
--
-- 설계 원칙:
--  1. 파일 실제 저장소 = 사용자 본인의 Google Drive
--     (Supabase Storage 미사용 → 무료 플랜 용량 보존)
--  2. DB 는 Drive 파일의 메타데이터 + 관계(템플릿/캠페인/수신자) 만 보관
--  3. 발송 시 Gmail 25MB 한도 초과 → 자동으로 Drive 공유 링크 fallback
--  4. 발송 이력(recipient_attachments) 은 캠페인 삭제와 무관하게 보존
--     (user_id / email / campaign_name 을 denormalize 해서 보존)
-- =============================================

-- 기존 attachments 테이블은 미사용 상태이므로 제거 후 재설계
DROP POLICY IF EXISTS "attachments: own" ON mailcaster.attachments;
DROP TABLE IF EXISTS mailcaster.attachments;

-- =============================================
-- 1) drive_attachments — Drive 파일 레퍼런스 (사용자 수준, 재사용 가능)
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.drive_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES mailcaster.profiles(id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,       -- Google Drive 파일 ID
  drive_folder_id TEXT,               -- MailCaster/attachments 폴더 (null = 사용자가 picker 로 고른 외부 파일)
  file_name TEXT NOT NULL,
  file_size BIGINT,                   -- 바이트 단위, 발송 시 25MB 체크용
  mime_type TEXT,
  md5_checksum TEXT,                  -- Drive 메타데이터 (무결성 비교용)
  web_view_link TEXT,                 -- "drive.google.com/file/d/…/view" 공유 링크
  is_public_shared BOOLEAN DEFAULT false,  -- "링크 있는 누구나 보기" 권한 설정됐는지
  source TEXT NOT NULL DEFAULT 'uploaded'  -- 'uploaded' = 앱이 올림 / 'picked' = 사용자가 Drive 에서 선택
    CHECK (source IN ('uploaded', 'picked')),
  deleted_from_drive_at TIMESTAMPTZ,  -- 사용자가 Drive 에서 지운 경우 기록 (발송 시 감지)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, drive_file_id)
);

CREATE INDEX IF NOT EXISTS idx_drive_attachments_user
  ON mailcaster.drive_attachments(user_id);

-- =============================================
-- 2) template_attachments — 템플릿에 붙은 첨부
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.template_attachments (
  template_id UUID NOT NULL REFERENCES mailcaster.templates(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES mailcaster.drive_attachments(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_template_attachments_template
  ON mailcaster.template_attachments(template_id, sort_order);

-- =============================================
-- 3) campaign_attachments — 캠페인에 붙은 첨부
--    RESTRICT: 캠페인이 이 파일을 참조하는 동안에는 drive_attachments 삭제 금지
--    (이력 보존을 위해)
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.campaign_attachments (
  campaign_id UUID NOT NULL REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES mailcaster.drive_attachments(id) ON DELETE RESTRICT,
  sort_order INT NOT NULL DEFAULT 0,
  delivery_mode TEXT                  -- 발송 시점에 결정됨 (draft 단계는 NULL)
    CHECK (delivery_mode IN ('attachment', 'link')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_attachments_campaign
  ON mailcaster.campaign_attachments(campaign_id, sort_order);

-- =============================================
-- 4) recipient_attachments — 발송 이력 (누구에게 어떤 파일이 갔는지)
--    캠페인/수신자 삭제 후에도 감사 추적이 가능하도록 email/campaign_name 을 denormalize
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.recipient_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES mailcaster.profiles(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES mailcaster.drive_attachments(id) ON DELETE RESTRICT,
  recipient_id UUID REFERENCES mailcaster.recipients(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,      -- denormalized (수신자 레코드 삭제돼도 남음)
  recipient_name TEXT,
  campaign_name TEXT,                 -- denormalized (캠페인 레코드 삭제돼도 남음)
  delivery_mode TEXT NOT NULL
    CHECK (delivery_mode IN ('attachment', 'link')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recipient_attachments_user
  ON mailcaster.recipient_attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_recipient_attachments_attachment
  ON mailcaster.recipient_attachments(attachment_id);
CREATE INDEX IF NOT EXISTS idx_recipient_attachments_recipient
  ON mailcaster.recipient_attachments(recipient_id);
CREATE INDEX IF NOT EXISTS idx_recipient_attachments_campaign
  ON mailcaster.recipient_attachments(campaign_id);

-- =============================================
-- RLS
-- =============================================
ALTER TABLE mailcaster.drive_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.template_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.campaign_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.recipient_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "drive_attachments: own" ON mailcaster.drive_attachments;
CREATE POLICY "drive_attachments: own" ON mailcaster.drive_attachments
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "template_attachments: own" ON mailcaster.template_attachments;
CREATE POLICY "template_attachments: own" ON mailcaster.template_attachments
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM mailcaster.templates t
      WHERE t.id = template_attachments.template_id AND t.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM mailcaster.templates t
      WHERE t.id = template_attachments.template_id AND t.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "campaign_attachments: own" ON mailcaster.campaign_attachments;
CREATE POLICY "campaign_attachments: own" ON mailcaster.campaign_attachments
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM mailcaster.campaigns c
      WHERE c.id = campaign_attachments.campaign_id AND c.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM mailcaster.campaigns c
      WHERE c.id = campaign_attachments.campaign_id AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "recipient_attachments: own" ON mailcaster.recipient_attachments;
CREATE POLICY "recipient_attachments: own" ON mailcaster.recipient_attachments
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================
-- 뷰: 파일별 발송 통계 (이력 페이지에서 사용)
-- =============================================
CREATE OR REPLACE VIEW mailcaster.attachment_send_stats
WITH (security_invoker = true) AS
SELECT
  a.id                               AS attachment_id,
  a.user_id                          AS user_id,
  a.file_name                        AS file_name,
  a.file_size                        AS file_size,
  a.mime_type                        AS mime_type,
  a.web_view_link                    AS web_view_link,
  a.deleted_from_drive_at            AS deleted_from_drive_at,
  a.created_at                       AS created_at,
  COUNT(ra.id)                       AS total_sends,
  COUNT(DISTINCT ra.recipient_email) AS unique_recipients,
  COUNT(DISTINCT ra.campaign_id)     AS unique_campaigns,
  MAX(ra.sent_at)                    AS last_sent_at
FROM mailcaster.drive_attachments a
LEFT JOIN mailcaster.recipient_attachments ra ON ra.attachment_id = a.id
GROUP BY a.id;
