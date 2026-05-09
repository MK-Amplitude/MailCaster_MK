-- =============================================
-- Phase 9.3 — 캠페인별 engagement 집계 뷰
-- ---------------------------------------------
-- 관계 관리 대시보드의 "캠페인별" 탭 + 캠페인 차트(오픈율 Top10 등) 용도.
-- recipients 를 campaign 별로 GROUP BY 하여 sent / open / reply / bounce 와
-- 비율을 한 번에 노출.
--
-- 보안: security_invoker — 호출자의 RLS 정책으로 제약 (org 멤버 행만 보임).
-- =============================================

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
  -- 카운트
  COUNT(*) FILTER (WHERE r.status = 'sent')                      AS sent_count,
  COALESCE(SUM(r.open_count) FILTER (WHERE r.status = 'sent'), 0) AS total_opens,
  COUNT(*) FILTER (WHERE r.status = 'sent' AND r.opened)         AS unique_opens,
  COUNT(*) FILTER (WHERE r.replied)                              AS reply_count,
  COUNT(*) FILTER (WHERE r.bounced)                              AS bounce_count,
  COUNT(*)                                                       AS total_recipients,
  -- 비율 (sent_count 기준 — 발송된 사람 중 오픈/답장 비율)
  CASE WHEN COUNT(*) FILTER (WHERE r.status = 'sent') > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE r.status = 'sent' AND r.opened)::numeric
        / COUNT(*) FILTER (WHERE r.status = 'sent') * 100,
      1
    )
    ELSE 0
  END                                                            AS open_rate,
  CASE WHEN COUNT(*) FILTER (WHERE r.status = 'sent') > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE r.replied)::numeric
        / COUNT(*) FILTER (WHERE r.status = 'sent') * 100,
      1
    )
    ELSE 0
  END                                                            AS reply_rate,
  -- 시간 정보
  MIN(r.sent_at) FILTER (WHERE r.status = 'sent') AS first_sent_at,
  MAX(r.sent_at) FILTER (WHERE r.status = 'sent') AS last_sent_at
FROM mailcaster.campaigns c
LEFT JOIN mailcaster.recipients r ON r.campaign_id = c.id
GROUP BY c.id;

COMMENT ON VIEW mailcaster.campaign_engagement IS
  '캠페인별 발송/오픈/답장/반송 집계 — 관계 관리 대시보드용.';

GRANT SELECT ON mailcaster.campaign_engagement TO anon, authenticated, service_role;
