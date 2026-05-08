-- =============================================
-- Phase 9.2 — customer_type 6분류 확장 + 연락처 engagement 집계 뷰
-- ---------------------------------------------
-- 1) customer_type CHECK 확장:
--    기존: amplitude_customer / prospect / general
--    추가: partner (파트너) / vendor (협력 벤더) / relationship (관계유지 파트너)
--
-- 2) contact_engagement 뷰:
--    연락처별 발송/오픈/답장 집계. 관계 관리 대시보드 용도.
--    recipients (per-campaign-per-contact) 를 contact 별로 GROUP BY 해서
--    last_sent_at / total_sent / total_opens / reply_count 를 한 번에 노출.
--
-- 보안: security_invoker — 호출자의 RLS 정책으로 제약 (org 멤버 행만 보임).
-- =============================================

-- (1) customer_type 제약 확장 — 기존 데이터에 영향 없음 (값을 줄이지 않고 늘림)
ALTER TABLE mailcaster.contacts
  DROP CONSTRAINT IF EXISTS contacts_customer_type_check;
ALTER TABLE mailcaster.contacts
  ADD CONSTRAINT contacts_customer_type_check
  CHECK (customer_type IN (
    'amplitude_customer',
    'prospect',
    'partner',
    'vendor',
    'relationship',
    'general'
  ));

-- (2) 연락처 engagement 집계 뷰
DROP VIEW IF EXISTS mailcaster.contact_engagement;

CREATE VIEW mailcaster.contact_engagement
WITH (security_invoker = true) AS
SELECT
  c.id,
  c.org_id,
  c.user_id,
  c.email,
  c.name,
  c.company,
  c.company_ko,
  c.company_en,
  c.parent_group,
  c.customer_type,
  c.department,
  c.job_title,
  c.display_title,
  c.is_unsubscribed,
  c.is_bounced,
  c.created_at AS contact_created_at,
  -- 발송 / 오픈 / 답장 집계
  COUNT(DISTINCT r.campaign_id) FILTER (WHERE r.status = 'sent') AS sent_campaigns,
  COUNT(*) FILTER (WHERE r.status = 'sent') AS total_sent,
  COALESCE(SUM(r.open_count) FILTER (WHERE r.status = 'sent'), 0) AS total_opens,
  COUNT(*) FILTER (WHERE r.replied = true) AS reply_count,
  -- 마지막 활동 시각들
  MAX(r.sent_at)         AS last_sent_at,
  MAX(r.first_opened_at) AS last_opened_at,
  MAX(r.replied_at)      AS last_replied_at,
  -- 마지막 보낸 캠페인 정보 (one-row latest)
  (
    SELECT jsonb_build_object(
      'campaign_id', cmp.id,
      'campaign_name', cmp.name,
      'sent_at', r2.sent_at,
      'opened', r2.opened,
      'open_count', r2.open_count,
      'replied', r2.replied
    )
    FROM mailcaster.recipients r2
    JOIN mailcaster.campaigns cmp ON cmp.id = r2.campaign_id
    WHERE r2.contact_id = c.id
      AND r2.status = 'sent'
    ORDER BY r2.sent_at DESC NULLS LAST
    LIMIT 1
  ) AS last_campaign
FROM mailcaster.contacts c
LEFT JOIN mailcaster.recipients r ON r.contact_id = c.id
GROUP BY c.id;

GRANT SELECT ON mailcaster.contact_engagement TO anon, authenticated, service_role;
