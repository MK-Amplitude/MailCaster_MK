-- =============================================
-- Phase 11 — 수신자별 개인화 본문/제목 오버라이드
-- ---------------------------------------------
-- AI 가 사람마다 살짝 다른 본문을 생성한 캠페인에서, recipients 행마다 자기
-- subject/body_html 을 가질 수 있게 한다. 발송 로직은 override 가 있으면 그것을,
-- 없으면 캠페인 레벨의 body_html 에 템플릿 변수 치환을 하는 식.
--
-- 컬럼:
--   subject_override   TEXT NULL — 이 사람에게만 다른 제목 (NULL = 캠페인 제목 사용)
--   body_html_override TEXT NULL — 이 사람에게만 다른 본문 (NULL = 캠페인 본문 + 템플릿 치환)
--
-- 보안: 기존 recipients RLS 그대로. 추가 정책 없음.
-- =============================================

ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS subject_override TEXT,
  ADD COLUMN IF NOT EXISTS body_html_override TEXT;

COMMENT ON COLUMN mailcaster.recipients.subject_override IS
  '개인화 발송 — 이 수신자에게만 다른 제목. NULL = 캠페인 제목 사용.';
COMMENT ON COLUMN mailcaster.recipients.body_html_override IS
  '개인화 발송 — 이 수신자에게만 다른 본문 HTML. NULL = 캠페인 본문 + 템플릿 변수 치환.';
