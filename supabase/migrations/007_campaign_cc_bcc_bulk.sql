-- ============================================================
-- 007_campaign_cc_bcc_bulk.sql
-- ------------------------------------------------------------
-- 캠페인 레벨 CC / BCC 주소와, "한 번에 보내기(bulk)" 발송 모드를
-- campaigns 테이블에 추가한다.
--
-- cc / bcc
--   - TEXT[] 로 저장 (이메일 문자열 배열)
--   - 개별(individual) / 일괄(bulk) 두 모드 모두에서 각 메일 헤더에
--     동일하게 포함된다.
--
-- send_mode
--   - 'individual' (기본): 수신자별로 Gmail API 를 반복 호출, 개인화 변수
--                         ({{name}}, {{company}} 등) 치환, send_delay_seconds
--                         간격 유지, recipient 별 성공/실패 기록.
--   - 'bulk'            : Gmail API 를 단 1회 호출. To 는 발신자 본인 주소,
--                         수신자 전원을 BCC 헤더에 넣어 "한 번에" 브로드캐스트.
--                         send_delay_seconds 는 무시되며, 개인화 변수가
--                         포함되어 있으면 프론트엔드에서 차단한다.
--                         성공 시 recipients 전원을 status='sent' + 공통
--                         gmail_message_id 로 일괄 업데이트한다.
-- ============================================================

ALTER TABLE mailcaster.campaigns
  ADD COLUMN IF NOT EXISTS cc        TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS bcc       TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS send_mode TEXT   NOT NULL DEFAULT 'individual';

-- send_mode 허용값 제약 — 이미 존재하면 재생성하지 않음
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'campaigns_send_mode_check'
  ) THEN
    ALTER TABLE mailcaster.campaigns
      ADD CONSTRAINT campaigns_send_mode_check
      CHECK (send_mode IN ('individual', 'bulk'));
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 참고: 조회용 뷰 (campaigns_summary 등) 가 있으면 새 컬럼을 포함하도록
-- 별도 재생성이 필요하다. 현재 001_phase1_schema.sql 에는 SELECT * 형태로
-- 정의되어 있지 않으므로 이 마이그레이션에서는 뷰 재생성이 필요 없다.
-- ------------------------------------------------------------
