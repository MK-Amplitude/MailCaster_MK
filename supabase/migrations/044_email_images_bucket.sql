-- =============================================
-- Phase 15 — 메일 본문 inline 이미지 호스팅용 public bucket
-- ---------------------------------------------
-- 사용자가 TipTap 에디터에서 이미지를 붙여넣기/업로드하면 Supabase Storage 의
-- 이 bucket 에 저장되고, 본문 HTML 에는 public URL 이 들어간다.
-- 메일 수신자가 메일을 열 때 외부 이미지로 보여지지만 src URL 이 영구적이므로
-- 한 번 "이미지 표시" 누른 후엔 정상 렌더링.
--
-- 정책:
--   - SELECT (다운로드/표시): public — 메일 수신자가 인증 없이 볼 수 있어야 함
--   - INSERT (업로드): authenticated — 로그인 사용자만
--   - UPDATE/DELETE: owner 또는 admin (storage.objects RLS 의 기본)
--   - 파일 경로: {user_id}/{uuid}-{filename} — 사용자 폴더 분리
-- =============================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'email-images',
  'email-images',
  true,
  10485760, -- 10MB
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO NOTHING;

-- RLS — public read 는 bucket.public=true 로 처리됨.
-- INSERT 는 정책 추가 필요 (authenticated 만).
DROP POLICY IF EXISTS "email_images: authenticated upload" ON storage.objects;
CREATE POLICY "email_images: authenticated upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'email-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 본인 파일만 수정/삭제 가능 (다른 사용자 파일 손상 방지)
DROP POLICY IF EXISTS "email_images: owner modify" ON storage.objects;
CREATE POLICY "email_images: owner modify"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'email-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "email_images: owner delete" ON storage.objects;
CREATE POLICY "email_images: owner delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'email-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
