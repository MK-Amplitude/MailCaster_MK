-- =============================================
-- Phase 9.4 — 답장(replied) 은 암묵적 오픈으로 간주
-- ---------------------------------------------
-- 배경:
--   오픈 추적은 메일 본문 picel(1x1 image) 로드 여부로 판정한다.
--   많은 기업/모바일 환경은 외부 이미지를 차단하므로,
--   메일을 읽고 답장까지 했는데 opened=false 인 경우가 종종 발생한다.
--   "답장 했지만 오픈 0" 표시는 사용자에게 데이터 오류처럼 보인다.
--
--   비즈니스 관점에서 답장은 오픈보다 강한 engagement 신호이므로,
--   집계 view 에서 replied=true 인 행은 최소 1회 오픈된 것으로 간주한다.
--
-- 변경 대상:
--   - mailcaster.contact_engagement (024): total_opens 계산 보정
--   - mailcaster.campaign_engagement (025): total_opens / unique_opens / open_rate 보정
-- =============================================

-- ------------------------------------------------
-- 1) contact_engagement 재생성
-- ------------------------------------------------
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
  -- total_opens: replied=true 면 최소 1로 보정 (픽셀 차단 환경 대응)
  COALESCE(
    SUM(
      GREATEST(
        r.open_count,
        CASE WHEN r.replied THEN 1 ELSE 0 END
      )
    ) FILTER (WHERE r.status = 'sent'),
    0
  ) AS total_opens,
  COUNT(*) FILTER (WHERE r.replied = true) AS reply_count,
  -- 마지막 활동 시각들
  MAX(r.sent_at)         AS last_sent_at,
  -- last_opened_at: 답장 시각도 implicit open 으로 포함 (둘 중 더 늦은 시각)
  GREATEST(MAX(r.first_opened_at), MAX(r.replied_at) FILTER (WHERE r.replied)) AS last_opened_at,
  MAX(r.replied_at)      AS last_replied_at,
  -- 마지막 보낸 캠페인 정보 (one-row latest)
  (
    SELECT jsonb_build_object(
      'campaign_id', cmp.id,
      'campaign_name', cmp.name,
      'sent_at', r2.sent_at,
      'opened', (r2.opened OR r2.replied),
      'open_count', GREATEST(r2.open_count, CASE WHEN r2.replied THEN 1 ELSE 0 END),
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

-- contact_history 컬럼 — 1열 누락된 컬럼 first_opened_at 이름 의존성
-- (recipients 테이블이 first_opened_at 으로 가지고 있는지 확인 필요)
-- 이 view 는 recipients.first_opened_at / replied_at 만 참조.

-- ------------------------------------------------
-- 2) campaign_engagement 재생성
-- ------------------------------------------------
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
  -- total_opens: 픽셀 카운트 + replied implicit (open_count 0 이면 1로 보정)
  COALESCE(
    SUM(
      GREATEST(
        r.open_count,
        CASE WHEN r.replied THEN 1 ELSE 0 END
      )
    ) FILTER (WHERE r.status = 'sent'),
    0
  ) AS total_opens,
  -- unique_opens: opened 또는 replied 둘 중 하나라도 true 면 카운트
  COUNT(*) FILTER (WHERE r.status = 'sent' AND (r.opened OR r.replied)) AS unique_opens,
  COUNT(*) FILTER (WHERE r.replied)                              AS reply_count,
  COUNT(*) FILTER (WHERE r.bounced)                              AS bounce_count,
  COUNT(*)                                                       AS total_recipients,
  -- 비율 (sent_count 기준)
  CASE WHEN COUNT(*) FILTER (WHERE r.status = 'sent') > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE r.status = 'sent' AND (r.opened OR r.replied))::numeric
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
  '캠페인별 발송/오픈/답장/반송 집계 — 답장은 암묵적 오픈으로 간주.';

GRANT SELECT ON mailcaster.campaign_engagement TO anon, authenticated, service_role;
