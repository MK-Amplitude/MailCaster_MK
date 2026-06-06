-- =============================================
-- 고도화 Tier 4-a — check-inbox Gmail History API 커서
-- ---------------------------------------------
-- 기존 시간기반(after:<sec>) 폴링은 매 tick 전체 inbox 를 스캔한다. Gmail History API
-- (users.history.list)는 startHistoryId 이후 "변경분(messageAdded)"만 반환해 호출량을 크게 줄인다.
--
-- last_history_id: 마지막으로 처리한 mailbox history id. check-inbox 가 이 값으로
--   history.list 를 호출. 값이 없거나 만료(404)면 시간기반 폴링으로 자동 폴백하고
--   처리 후 현재 historyId 를 다시 저장한다. (last_inbox_check_at 폴백 커서는 그대로 유지)
-- =============================================

ALTER TABLE mailcaster.profiles
  ADD COLUMN IF NOT EXISTS last_history_id TEXT;

COMMENT ON COLUMN mailcaster.profiles.last_history_id IS
  'check-inbox 의 Gmail History API 커서 — 이 history id 이후 변경분만 폴링. 만료 시 시간기반(last_inbox_check_at)으로 폴백.';
