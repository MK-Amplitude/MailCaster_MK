-- =============================================
-- 고도화 Tier 3 — 분석 집계 RPC (outbound 퍼널 + 세그먼트별 성과)
-- ---------------------------------------------
-- 기존 데이터(recipients + thread_messages + contacts)로 안전한 read-only 집계.
-- org 스코프는 user_org_ids(). 발송원: 캠페인(recipients) + 시퀀스/1:1(thread_messages),
-- 둘 다 비-bounce 만 분모에 포함.
--
-- 주의: 제목 A/B 테스트는 발송 경로 변경이 필요해 별도 작업으로 분리.
-- =============================================

-- 1) 전체 outbound 퍼널 — 발송/오픈/회신
CREATE OR REPLACE FUNCTION mailcaster.outbound_funnel(p_since TIMESTAMPTZ)
RETURNS TABLE (sent BIGINT, opened BIGINT, replied BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
  WITH orgs AS (SELECT mailcaster.user_org_ids() AS org_id),
  sends AS (
    SELECT COALESCE(r.opened, FALSE) AS opened, COALESCE(r.replied, FALSE) AS replied
      FROM mailcaster.recipients r
      JOIN mailcaster.campaigns ca ON ca.id = r.campaign_id
     WHERE ca.org_id IN (SELECT org_id FROM orgs)
       AND r.status IN ('sent', 'bounced')
       AND r.sent_at >= p_since
       AND COALESCE(r.bounced, FALSE) = FALSE
    UNION ALL
    SELECT COALESCE(tm.opened, FALSE), COALESCE(tm.replied, FALSE)
      FROM mailcaster.thread_messages tm
     WHERE tm.org_id IN (SELECT org_id FROM orgs)
       AND tm.status = 'sent'
       AND tm.sent_at >= p_since
       AND COALESCE(tm.bounced, FALSE) = FALSE
  )
  SELECT
    COUNT(*) AS sent,
    COUNT(*) FILTER (WHERE opened) AS opened,
    COUNT(*) FILTER (WHERE replied) AS replied
  FROM sends;
$$;

REVOKE ALL ON FUNCTION mailcaster.outbound_funnel(TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.outbound_funnel(TIMESTAMPTZ) TO authenticated;

-- 2) 세그먼트별 성과 — parent_group / customer_type / job_title 별 발송·오픈·회신
CREATE OR REPLACE FUNCTION mailcaster.reply_rate_by_segment(
  p_since TIMESTAMPTZ,
  p_dim   TEXT
)
RETURNS TABLE (segment TEXT, sent BIGINT, opened BIGINT, replied BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
  WITH orgs AS (SELECT mailcaster.user_org_ids() AS org_id),
  sends AS (
    SELECT
      CASE p_dim
        WHEN 'customer_type' THEN c.customer_type
        WHEN 'job_title'     THEN c.job_title
        ELSE c.parent_group
      END AS seg,
      COALESCE(r.opened, FALSE)  AS opened,
      COALESCE(r.replied, FALSE) AS replied
      FROM mailcaster.recipients r
      JOIN mailcaster.campaigns ca ON ca.id = r.campaign_id
      JOIN mailcaster.contacts  c  ON c.id = r.contact_id
     WHERE ca.org_id IN (SELECT org_id FROM orgs)
       AND r.status IN ('sent', 'bounced')
       AND r.sent_at >= p_since
       AND COALESCE(r.bounced, FALSE) = FALSE
    UNION ALL
    SELECT
      CASE p_dim
        WHEN 'customer_type' THEN c.customer_type
        WHEN 'job_title'     THEN c.job_title
        ELSE c.parent_group
      END,
      COALESCE(tm.opened, FALSE),
      COALESCE(tm.replied, FALSE)
      FROM mailcaster.thread_messages tm
      JOIN mailcaster.contacts c ON c.id = tm.contact_id
     WHERE tm.org_id IN (SELECT org_id FROM orgs)
       AND tm.status = 'sent'
       AND tm.sent_at >= p_since
       AND COALESCE(tm.bounced, FALSE) = FALSE
  )
  SELECT
    COALESCE(NULLIF(TRIM(seg), ''), '(미지정)') AS segment,
    COUNT(*) AS sent,
    COUNT(*) FILTER (WHERE opened) AS opened,
    COUNT(*) FILTER (WHERE replied) AS replied
  FROM sends
  GROUP BY 1
  ORDER BY sent DESC
  LIMIT 100;
$$;

REVOKE ALL ON FUNCTION mailcaster.reply_rate_by_segment(TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.reply_rate_by_segment(TIMESTAMPTZ, TEXT) TO authenticated;

COMMENT ON FUNCTION mailcaster.outbound_funnel IS
  '최근 기간 outbound(캠페인+시퀀스/1:1) 발송/오픈/회신 집계 (Tier 3 분석).';
COMMENT ON FUNCTION mailcaster.reply_rate_by_segment IS
  '세그먼트(parent_group/customer_type/job_title)별 발송/오픈/회신 집계 (Tier 3 분석).';
