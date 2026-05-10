-- =============================================
-- Phase 9.6 — 답장 자동 분류 (interested / not_interested / question / out_of_office / unclear)
-- ---------------------------------------------
-- 배경:
--   "답장 1" 만 보고는 관심인지 거절인지 부재중 자동응답인지 모름. 영업이 우선순위
--   판단하려면 답장의 톤/의도를 빠르게 파악해야 한다. LLM 으로 답장 본문을 분류해
--   recipients.reply_category 에 캐시한다.
--
-- 분류 카테고리 (5종):
--   interested     관심·긍정 — 미팅·후속 컨택 의향
--   not_interested 정중한 거절 — 추가 푸시 자제
--   question       구체적 질문/요청 — 응답 필요
--   out_of_office  자동응답·부재중 — 인간 액션 불필요
--   unclear        분류 애매 / LLM 신뢰도 낮음
--
-- 분류 시점: check-replies cron 이 답장을 처음 감지한 직후 그 thread 의 본문을
--           가져와 1회 분류. 이후 update 없음 (사용자가 thread 안에서 추가 메시지를
--           주고받아도 재분류는 안 함 — 첫 답장의 톤이 액션 결정에 가장 중요).
--
-- 보안: RLS 변경 없음 — 기존 recipients 정책 그대로 적용.
-- =============================================

ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS reply_category TEXT;

ALTER TABLE mailcaster.recipients
  DROP CONSTRAINT IF EXISTS recipients_reply_category_check;

ALTER TABLE mailcaster.recipients
  ADD CONSTRAINT recipients_reply_category_check
  CHECK (
    reply_category IS NULL
    OR reply_category IN (
      'interested',
      'not_interested',
      'question',
      'out_of_office',
      'unclear'
    )
  );

-- 부분 인덱스 — 분류된 답장만. campaign 별로 카테고리 필터/집계할 때 가속.
-- 미분류(NULL) 행은 인덱스에서 제외해 인덱스 크기 작게.
CREATE INDEX IF NOT EXISTS idx_recipients_reply_category
  ON mailcaster.recipients (campaign_id, reply_category)
  WHERE reply_category IS NOT NULL;

COMMENT ON COLUMN mailcaster.recipients.reply_category IS
  '답장 자동 분류 — interested/not_interested/question/out_of_office/unclear. NULL=미분류.';
