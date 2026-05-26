-- =============================================
-- Phase 18.1 — thread_messages 회신 추적 결함 수정
-- ---------------------------------------------
-- 감사에서 발견된 결함:
--   C1) pass3 cron 이 replied=false 만 폴링 → 두 번째 이후 회신 영원히 누락
--       fetchThreadAnalysis 도 "가장 이른 타인 메시지" 만 반환.
--   M4) thread_messages.user_id 가 NOT NULL + FK ON DELETE SET NULL —
--       사용자 삭제 시 NULL 을 NOT NULL 컬럼에 넣으려다 트랜잭션 실패.
--
-- 이 마이그레이션:
--   1. user_id 의 NOT NULL 제약 제거 (FK 의 SET NULL 의도와 일치).
--   2. pass3 의 새 쿼리 (cooldown 기반 재방문) 에 맞는 partial index 추가.
-- =============================================

-- 1) user_id FK 의 ON DELETE SET NULL 과 일치하도록 NOT NULL 제거
ALTER TABLE mailcaster.thread_messages
  ALTER COLUMN user_id DROP NOT NULL;

COMMENT ON COLUMN mailcaster.thread_messages.user_id IS
  '발송한 사용자. 사용자 삭제 시 NULL (FK ON DELETE SET NULL). 발송 이력은 org 단위로 보존.';

-- 2) pass3 의 새 쿼리 패턴 — cooldown 기반으로 replied 상태 무관하게 재방문
-- 기존 idx_thread_messages_reply_check (replied=FALSE 만 커버) 는 그대로 두고,
-- 추가로 sent + thread 있는 모든 행을 last_reply_check_at 순으로 정렬하는 인덱스 추가.
-- partial index 라 인덱스 크기 통제됨.
CREATE INDEX IF NOT EXISTS idx_thread_messages_reply_recheck
  ON mailcaster.thread_messages (last_reply_check_at NULLS FIRST)
  WHERE status = 'sent' AND gmail_thread_id IS NOT NULL;

COMMENT ON INDEX mailcaster.idx_thread_messages_reply_recheck IS
  'check-replies cron pass3 의 cooldown 기반 polling 큐. replied 상태 무관 — 다중 회신 감지를 위함.';
