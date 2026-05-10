-- =============================================
-- Phase 11.1.1 — contact_engagement / campaign_engagement 에 "내 답장 대기" 카운트 노출
-- ---------------------------------------------
-- 032 의 last_thread_message_from_me 를 활용해 "고객이 답장했는데 내가 아직 답장 안 한"
-- thread 수를 view 에 집계.
-- =============================================

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
  COUNT(DISTINCT r.campaign_id) FILTER (WHERE r.status = 'sent') AS sent_campaigns,
  COUNT(*) FILTER (WHERE r.status = 'sent') AS total_sent,
  COALESCE(
    SUM(GREATEST(r.open_count, CASE WHEN r.replied THEN 1 ELSE 0 END))
      FILTER (WHERE r.status = 'sent'),
    0
  ) AS total_opens,
  COUNT(*) FILTER (WHERE r.replied = true) AS reply_count,
  COUNT(*) FILTER (WHERE r.replied = true AND r.reply_category = 'interested') AS interested_reply_count,
  -- NEW: 답장 받았으나 내가 답장 안 한 (last_thread_message_from_me=false) 행 수
  COUNT(*) FILTER (
    WHERE r.replied = true AND r.last_thread_message_from_me = false
  ) AS awaiting_my_response_count,
  MAX(r.sent_at) AS last_sent_at,
  GREATEST(MAX(r.first_opened_at), MAX(r.replied_at) FILTER (WHERE r.replied)) AS last_opened_at,
  MAX(r.replied_at) AS last_replied_at,
  (
    SELECT jsonb_build_object(
      'campaign_id', cmp.id,
      'campaign_name', cmp.name,
      'sent_at', r2.sent_at,
      'opened', (r2.opened OR r2.replied),
      'open_count', GREATEST(r2.open_count, CASE WHEN r2.replied THEN 1 ELSE 0 END),
      'replied', r2.replied,
      'reply_category', r2.reply_category
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

DROP VIEW IF EXISTS mailcaster.campaign_engagement;

CREATE VIEW mailcaster.campaign_engagement
WITH (security_invoker = true) AS
SELECT
  c.id,
  c.org_id,
  c.user_id,
  c.name,
  c.subject,
  c.status,
  c.created_at,
  c.scheduled_at,
  COUNT(*) FILTER (WHERE r.status = 'sent') AS sent_count,
  COALESCE(
    SUM(GREATEST(r.open_count, CASE WHEN r.replied THEN 1 ELSE 0 END))
      FILTER (WHERE r.status = 'sent'),
    0
  ) AS total_opens,
  COUNT(*) FILTER (WHERE r.status = 'sent' AND (r.opened OR r.replied)) AS unique_opens,
  COUNT(*) FILTER (WHERE r.replied) AS reply_count,
  COUNT(*) FILTER (WHERE r.replied AND r.reply_category = 'interested') AS interested_reply_count,
  -- NEW: 캠페인별 "내 답장 대기" 수
  COUNT(*) FILTER (
    WHERE r.replied AND r.last_thread_message_from_me = false
  ) AS awaiting_my_response_count,
  COUNT(*) FILTER (WHERE r.bounced) AS bounce_count,
  COUNT(*) AS total_recipients,
  CASE WHEN COUNT(*) FILTER (WHERE r.status = 'sent') > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE r.status = 'sent' AND (r.opened OR r.replied))::numeric
        / COUNT(*) FILTER (WHERE r.status = 'sent') * 100,
      1
    )
    ELSE 0
  END AS open_rate,
  CASE WHEN COUNT(*) FILTER (WHERE r.status = 'sent') > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE r.replied)::numeric
        / COUNT(*) FILTER (WHERE r.status = 'sent') * 100,
      1
    )
    ELSE 0
  END AS reply_rate,
  MIN(r.sent_at) FILTER (WHERE r.status = 'sent') AS first_sent_at,
  MAX(r.sent_at) FILTER (WHERE r.status = 'sent') AS last_sent_at
FROM mailcaster.campaigns c
LEFT JOIN mailcaster.recipients r ON r.campaign_id = c.id
GROUP BY c.id;

GRANT SELECT ON mailcaster.campaign_engagement TO anon, authenticated, service_role;
