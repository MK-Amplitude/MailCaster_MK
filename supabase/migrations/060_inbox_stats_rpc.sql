-- =============================================
-- 고도화 QW2 — 받은편지함 통계 집계 RPC
-- ---------------------------------------------
-- 기존: useInboxStats 가 30일치 inbound + outbound(thread_messages+recipients) 전량을
--       클라이언트로 가져와 JS 루프로 집계 (페이로드 큼, GROUP BY 미사용, 확장성 약함).
-- 개선: 단일 SECURITY DEFINER 집계 RPC 로 DB 에서 계산해 카운트만 반환.
--
-- org 스코프: 기존 훅이 RLS 에 의존했던 것과 동일하게 user_org_ids() 로 한정.
-- 타임존: "오늘" 경계는 클라이언트 로컬 자정(p_today_start)을 그대로 받아 기존 동작과 일치.
-- =============================================

CREATE OR REPLACE FUNCTION mailcaster.inbox_stats(
  p_since       TIMESTAMPTZ,
  p_today_start TIMESTAMPTZ
)
RETURNS TABLE (
  total            BIGINT,
  today_count      BIGINT,
  unreplied_count  BIGINT,
  outbound_sent    BIGINT,
  outbound_opened  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
  WITH orgs AS (
    SELECT mailcaster.user_org_ids() AS org_id
  ),
  inb AS (
    SELECT i.gmail_thread_id, i.received_at
      FROM mailcaster.inbound_messages i
     WHERE i.org_id IN (SELECT org_id FROM orgs)
       AND i.received_at >= p_since
  ),
  inbound_agg AS (
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE inb.received_at >= p_today_start) AS today_count,
      -- 미응답: 같은 thread 에 received_at 이후 우리 발송(status='sent')이 하나도 없으면 미응답.
      -- gmail_thread_id 가 NULL 이면 매칭 자체가 불가 → 미응답 (isInboundUnreplied 와 동일).
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1
            FROM mailcaster.thread_messages tm
           WHERE tm.org_id IN (SELECT org_id FROM orgs)
             AND tm.status = 'sent'
             AND tm.gmail_thread_id = inb.gmail_thread_id
             AND tm.sent_at >= inb.received_at
        )
      ) AS unreplied_count
    FROM inb
  ),
  -- outbound: thread_messages(sent, 비-bounce) + recipients(sent/bounced, 비-bounce)
  out_thread AS (
    SELECT
      COUNT(*) AS sent,
      COUNT(*) FILTER (WHERE tm.opened) AS opened
      FROM mailcaster.thread_messages tm
     WHERE tm.org_id IN (SELECT org_id FROM orgs)
       AND tm.status = 'sent'
       AND tm.sent_at >= p_since
       AND COALESCE(tm.bounced, FALSE) = FALSE
  ),
  out_rec AS (
    SELECT
      COUNT(*) AS sent,
      COUNT(*) FILTER (WHERE COALESCE(r.opened, FALSE)) AS opened
      FROM mailcaster.recipients r
      JOIN mailcaster.campaigns c ON c.id = r.campaign_id
     WHERE c.org_id IN (SELECT org_id FROM orgs)
       AND r.status IN ('sent', 'bounced')
       AND r.sent_at >= p_since
       AND COALESCE(r.bounced, FALSE) = FALSE
  )
  SELECT
    ia.total,
    ia.today_count,
    ia.unreplied_count,
    (ot.sent + orr.sent)     AS outbound_sent,
    (ot.opened + orr.opened) AS outbound_opened
  FROM inbound_agg ia, out_thread ot, out_rec orr;
$$;

REVOKE ALL ON FUNCTION mailcaster.inbox_stats(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.inbox_stats(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION mailcaster.inbox_stats IS
  '받은편지함 KPI 집계 — inbound(total/today/unreplied) + outbound(sent/opened). user_org_ids() 로 org 스코프. useInboxStats 가 호출.';
