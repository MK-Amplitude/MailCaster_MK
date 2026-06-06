-- =============================================
-- Phase 20.2 — campaigns.kind backfill NULL 정정
-- ---------------------------------------------
-- 058 의 backfill 이 `total_count <= 1` 만 처리해서 total_count IS NULL 인 row 를 놓침.
-- (campaigns.total_count 는 INT DEFAULT 0 이지만 nullable)
-- NULL 이면 NULL <= 1 → NULL (거짓) 이라 'broadcast' 로 잔존 → 1:1 인데 broadcast 분류.
--
-- COALESCE 로 NULL 을 0 으로 보고 재분류.
-- =============================================

UPDATE mailcaster.campaigns
   SET kind = 'one_to_one'
 WHERE kind = 'broadcast'
   AND COALESCE(total_count, 0) <= 1;
