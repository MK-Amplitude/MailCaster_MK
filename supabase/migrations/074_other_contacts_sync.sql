-- 074_other_contacts_sync.sql
-- =====================================================================
-- Google "기타 주소록" (Other contacts) 동기화 지원
--
-- people/me/connections 는 "연락처" 로 저장된 사람만 반환한다.
-- Gmail 이 자동 수집한 상대 (기타 주소록) 는 otherContacts.list 로 별도 조회 —
-- 별도 sync token 과 사용자 opt-in 토글이 필요.
--
-- 주의: otherContacts 는 contacts.other.readonly scope 필요 —
-- 토글 on 후 재로그인해야 권한이 부여된다 (AuthContext scope 에 추가됨).
-- =====================================================================

ALTER TABLE mailcaster.profiles
  ADD COLUMN IF NOT EXISTS google_contacts_include_other BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS google_contacts_other_sync_token TEXT;

COMMENT ON COLUMN mailcaster.profiles.google_contacts_include_other IS
  '기타 주소록(otherContacts) 동기화 opt-in. contacts.other.readonly scope 재동의 필요.';
COMMENT ON COLUMN mailcaster.profiles.google_contacts_other_sync_token IS
  'People API otherContacts.list 전용 incremental sync token (connections 토큰과 별개).';
