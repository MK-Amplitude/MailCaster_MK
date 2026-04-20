-- =============================================
-- Phase 8 — LOWER(email) 비교용 함수형 인덱스
-- ---------------------------------------------
-- 배경:
--   019 트리거가 `LOWER(email) = LOWER(NEW.email)` 로 unsubscribes ↔ contacts 를 비교.
--   기존 UNIQUE(org_id, email) 인덱스는 plain-text 비교용이라 LOWER() 에 못 탐
--   → 매 contacts INSERT 마다 unsubscribes seq scan 발생 (N+1 + full scan).
--
--   apply_unsubscribe_to_new_contact 는 contacts INSERT 마다 1회 SELECT,
--   sync_contacts_on_unsubscribe_change 는 unsubscribes 변경 시 contacts UPDATE.
--   양쪽 모두 성능에 영향.
--
-- 해결:
--   함수형 인덱스 `(org_id, LOWER(email))` 추가 — 013 org_invitations 의
--   `idx_org_invitations_email ON org_invitations(LOWER(email))` 패턴과 동일.
--
--   `IF NOT EXISTS` 가드로 재실행 안전.
-- =============================================

-- unsubscribes — 019 apply_unsubscribe_to_new_contact 가 SELECT 에 사용
CREATE INDEX IF NOT EXISTS idx_unsubscribes_org_lower_email
  ON mailcaster.unsubscribes (org_id, LOWER(email));

-- blacklist — 향후 트리거/필터에서 같은 패턴으로 확장 대비
CREATE INDEX IF NOT EXISTS idx_blacklist_org_lower_email
  ON mailcaster.blacklist (org_id, LOWER(email));

-- contacts — 019 sync_contacts_on_unsubscribe_change 의 UPDATE 가 사용
CREATE INDEX IF NOT EXISTS idx_contacts_org_lower_email
  ON mailcaster.contacts (org_id, LOWER(email));
