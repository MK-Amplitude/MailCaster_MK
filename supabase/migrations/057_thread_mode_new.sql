-- =============================================
-- Phase 20 — ad-hoc 1:1 메일 발송 (mode='new')
-- ---------------------------------------------
-- 기존 thread_messages.mode CHECK 에 'new' 추가.
-- 'new' = 캠페인/follow-up/reply/forward 가 아닌 처음부터 1:1 작성한 메일.
-- ad-hoc 작성 진입점 (Topbar "+ 메일 작성", ContactDetailSheet "메일 작성") 에서 사용.
-- =============================================

ALTER TABLE mailcaster.thread_messages
  DROP CONSTRAINT IF EXISTS thread_messages_mode_check;

ALTER TABLE mailcaster.thread_messages
  ADD CONSTRAINT thread_messages_mode_check
    CHECK (mode IN ('followup', 'reply', 'forward', 'new'));

COMMENT ON COLUMN mailcaster.thread_messages.mode IS
  '액션 종류: followup (같은 thread 추가) / reply (받은 답장에 답) / forward (다른 사람에게 전달) / new (ad-hoc 1:1).';
