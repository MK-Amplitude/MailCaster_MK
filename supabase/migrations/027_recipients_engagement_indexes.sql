-- =============================================
-- Phase 9.5 — recipients 조회 성능 인덱스 보강
-- ---------------------------------------------
-- 신규 인덱스:
--   1) idx_recipients_contact_sent
--      목적: useContactSendHistory — 한 연락처의 발송 이력을 sent_at desc 로 가져옴.
--      쿼리: WHERE contact_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 20
--      현재: contact_id 단독 인덱스 없음 → seq scan
--
--   2) idx_recipients_replied
--      목적: contact_engagement / campaign_engagement view 의 reply 집계 가속.
--      쿼리: COUNT(*) FILTER (WHERE replied = true)  GROUP BY contact_id|campaign_id
--      partial index (replied=true) 로 답장된 행만 인덱싱 → 작고 빠름.
--
--   3) idx_recipients_campaign_sent
--      목적: campaign_engagement view 의 GROUP BY campaign_id + 발송 집계.
--      현재 campaign_id FK 만 있을 가능성 → status 까지 포함한 covering 으로 보강.
-- =============================================

CREATE INDEX IF NOT EXISTS idx_recipients_contact_sent
  ON mailcaster.recipients (contact_id, sent_at DESC NULLS LAST)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_recipients_replied
  ON mailcaster.recipients (contact_id, replied_at DESC NULLS LAST)
  WHERE replied = TRUE;

CREATE INDEX IF NOT EXISTS idx_recipients_campaign_sent
  ON mailcaster.recipients (campaign_id, status);

COMMENT ON INDEX mailcaster.idx_recipients_contact_sent IS
  'useContactSendHistory: 연락처별 발송 이력 정렬 조회 가속';
COMMENT ON INDEX mailcaster.idx_recipients_replied IS
  'engagement view: 답장 카운트/시각 집계 가속 (partial)';
COMMENT ON INDEX mailcaster.idx_recipients_campaign_sent IS
  'campaign_engagement view: campaign 별 status 집계 가속';
