-- 070_encrypt_google_tokens.sql
-- =====================================================================
-- Google OAuth 토큰 암호화 지원 마이그레이션
-- =====================================================================
--
-- 목적: google_refresh_token / google_access_token 컬럼에 AES-256-GCM 으로
--       암호화된 값을 저장할 수 있도록 컬럼 크기를 확보하고
--       (기존 TEXT 는 암호화 후에도 충분하지만 명시적 comment 추가).
--       실제 암호화/복호화는 Edge Function (_shared/tokenCrypto.ts) 에서 수행.
--
-- 중요: 이 마이그레이션은 기존 저장된 평문 토큰을 암호화하지 않는다.
--       기존 토큰은 'v1:' prefix 가 없으므로 decryptToken() 이 평문으로 처리한다
--       (하위 호환 유지). 운영 환경에서는 별도 one-time 스크립트로
--       기존 토큰을 재암호화하거나 사용자 재로그인을 유도한다.
--
-- 운영 환경 설정 필요:
--   1) TOKEN_ENCRYPTION_KEY secret 을 Supabase dashboard 에 등록
--      (Edge Function > Secrets 또는 supabase secrets set TOKEN_ENCRYPTION_KEY=<base64url 32 bytes>)
--   2) 등록 후 Edge Functions 재배포
-- =====================================================================

-- 컬럼 comment 추가 (감사 목적)
COMMENT ON COLUMN mailcaster.profiles.google_refresh_token IS
  'Google OAuth refresh token. 값이 "v1:" 로 시작하면 AES-256-GCM 암호화 (tokenCrypto.ts). 아니면 평문 (레거시).';

COMMENT ON COLUMN mailcaster.profiles.google_access_token IS
  'Google OAuth access token. refresh-google-token Edge Function 이 갱신 시 암호화해서 저장.';
