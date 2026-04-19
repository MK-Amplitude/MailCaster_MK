-- ============================================================
-- 010_phase6_tracking_replies_exclusions.sql
-- ------------------------------------------------------------
-- Phase 6 통합 마이그레이션 — 4개 트랙의 DB 변경을 한 파일에 모은다.
--
-- 기존 스키마(001) 를 최대한 재활용:
--   - recipients.opened / opened_at / open_count — 재사용 (오픈 추적)
--   - recipients.replied / replied_at           — 재사용 (답장 감지)
--   - recipients.bounced / bounced_at           — 재사용 (반송)
--   - open_events 테이블                         — 재사용 (상세 오픈 로그)
-- 새로 필요한 것만 ADD COLUMN / CREATE TABLE 한다.
--
--   A. 스케줄 발송 타임아웃 복원력
--      campaigns: sending_started_at, last_processed_recipient_id
--      (Edge function 이 50초 예산 소진 시 체크포인트를 기록하고,
--       다음 cron tick 이 이어서 처리)
--
--   C. 오픈 / 바운스 추적
--      recipients: first_opened_at, bounce_reason   — 신규
--      open_events: ip 컬럼 추가                    — 확장
--      track_email_open(): 서비스롤 RPC             — 픽셀 엔드포인트에서 atomically 기록
--
--   D. 답장 감지
--      recipients: last_reply_check_at              — 신규 (check-replies cron 이 참조)
--      (has_reply 는 기존 replied 컬럼 재사용)
--
--   B. 수신자 제외 목록
--      campaign_exclusions: 캠페인 단위 제외 연락처 (신규 테이블)
--
-- 변경 이력:
--   v1 (2026-04) — Phase 6 최초 도입.
-- ============================================================

-- ------------------------------------------------------------
-- A. campaigns 체크포인트 컬럼
-- ------------------------------------------------------------
ALTER TABLE mailcaster.campaigns
  ADD COLUMN IF NOT EXISTS sending_started_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_processed_recipient_id UUID;

-- cron 쿼리가 status IN ('scheduled','sending') 를 스캔할 때 sending 쪽 재개 대상 찾기
-- (idx_campaigns_scheduled_due 는 status='scheduled' partial — 유지)
CREATE INDEX IF NOT EXISTS idx_campaigns_sending_resume
  ON mailcaster.campaigns (scheduled_at)
  WHERE status = 'sending' AND sending_started_at IS NOT NULL;

COMMENT ON COLUMN mailcaster.campaigns.sending_started_at IS
  'Phase 6 — 스케줄 발송이 Edge function 에 의해 처음 집어진 시각. NULL 이면 아직 미시작.';
COMMENT ON COLUMN mailcaster.campaigns.last_processed_recipient_id IS
  'Phase 6 — 마지막으로 성공/실패 처리된 recipient.id. 재개 시 이 이후의 pending 부터 처리.';


-- ------------------------------------------------------------
-- C. recipients — 기존 opened/opened_at/open_count 는 유지,
--    "첫 오픈 시각" 과 "바운스 사유" 만 추가
-- ------------------------------------------------------------
ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS first_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounce_reason   TEXT;

-- "열린 수신자만" 빠르게 훑을 때 사용
CREATE INDEX IF NOT EXISTS idx_recipients_opened
  ON mailcaster.recipients (campaign_id)
  WHERE opened = TRUE;


-- ------------------------------------------------------------
-- C. open_events — 기존 테이블에 ip 컬럼 추가
-- ------------------------------------------------------------
ALTER TABLE mailcaster.open_events
  ADD COLUMN IF NOT EXISTS ip TEXT;

-- 캠페인별 최근 오픈 조회 성능용
CREATE INDEX IF NOT EXISTS idx_open_events_campaign_opened_at
  ON mailcaster.open_events (campaign_id, opened_at DESC);


-- ------------------------------------------------------------
-- C. track_email_open — 오픈 기록 RPC (Edge function 에서 호출)
-- ------------------------------------------------------------
-- 픽셀 엔드포인트는 인증 없이 GET 으로 들어오므로 service_role 키로 RPC 호출.
-- 이 함수는 세 가지를 atomic 하게 처리:
--   1) recipient 가 실제로 해당 campaign 에 속해 있는지 검증 (FK 외 추가 가드)
--   2) open_events 에 감사 로그 행 추가
--   3) recipients 의 opened / first_opened_at / opened_at / open_count 업데이트
--
-- 보안: 픽셀 URL 자체가 capability 역할 (rid+cid 조합). 유출 시 위조 호출 가능성은
--   존재하지만 그 영향은 "오픈 카운터 부풀림" 정도로 제한 — 향후 HMAC 서명 고려.
CREATE OR REPLACE FUNCTION mailcaster.track_email_open(
  p_recipient_id UUID,
  p_campaign_id  UUID,
  p_ip           TEXT DEFAULT NULL,
  p_user_agent   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
BEGIN
  -- 1) recipient × campaign 유효성
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.recipients
     WHERE id = p_recipient_id
       AND campaign_id = p_campaign_id
  ) THEN
    RETURN; -- 픽셀은 항상 200 을 돌려줘야 하므로 에러 X
  END IF;

  -- 2) 감사 로그
  INSERT INTO mailcaster.open_events (recipient_id, campaign_id, ip, user_agent)
    VALUES (p_recipient_id, p_campaign_id, p_ip, p_user_agent);

  -- 3) 수신자 카운터 — 첫 오픈이면 opened/first_opened_at 세팅
  UPDATE mailcaster.recipients
     SET opened          = TRUE,
         first_opened_at = COALESCE(first_opened_at, NOW()),
         opened_at       = NOW(), -- 마지막 오픈 시각으로 취급
         open_count      = COALESCE(open_count, 0) + 1
   WHERE id = p_recipient_id;

  -- 4) 캠페인 집계 — 첫 오픈이면 open_count 증가
  UPDATE mailcaster.campaigns c
     SET open_count = COALESCE(c.open_count, 0) + 1
    FROM mailcaster.recipients r
   WHERE r.id = p_recipient_id
     AND c.id = r.campaign_id
     AND r.open_count = 1; -- 방금 UPDATE 로 1 이 된 직후에만 → 첫 오픈만 집계에 반영
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.track_email_open(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.track_email_open(UUID, UUID, TEXT, TEXT) TO service_role;


-- ------------------------------------------------------------
-- D. recipients — 답장 체크 cron 을 위한 컬럼 1 개만 추가
--    (has_reply/last_reply_at 은 기존 replied/replied_at 재사용)
-- ------------------------------------------------------------
ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS last_reply_check_at TIMESTAMPTZ;

-- check-replies cron 이 "가장 오래 전 체크된 것부터" 배치 처리할 때 사용
CREATE INDEX IF NOT EXISTS idx_recipients_reply_check
  ON mailcaster.recipients (last_reply_check_at NULLS FIRST)
  WHERE status = 'sent' AND gmail_thread_id IS NOT NULL AND replied = FALSE;


-- ------------------------------------------------------------
-- B. campaign_exclusions — 수신자 제외 목록
-- ------------------------------------------------------------
-- "이 그룹을 담았지만 김철수는 빼고 싶다" 같은 케이스.
-- preview / recipients 계산 시 (campaign_groups ∪ campaign_contacts) MINUS campaign_exclusions 로
-- 최종 수신자 집합을 결정한다.
CREATE TABLE IF NOT EXISTS mailcaster.campaign_exclusions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  contact_id  UUID REFERENCES mailcaster.contacts(id)  ON DELETE CASCADE NOT NULL,
  excluded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_exclusions_campaign
  ON mailcaster.campaign_exclusions (campaign_id);

ALTER TABLE mailcaster.campaign_exclusions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaign_exclusions: own" ON mailcaster.campaign_exclusions
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );


-- ------------------------------------------------------------
-- 참고: cron job — check-replies 를 5분마다 호출
-- 008 과 같은 Vault 시크릿 재사용. Edge function 이 준비된 후에도 이 schedule 은
-- 이미 돌고 있으니 함수만 배포하면 바로 작동.
-- ------------------------------------------------------------
DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-check-replies') THEN
    PERFORM cron.unschedule('mailcaster-check-replies');
  END IF;
END
$unsched$;

SELECT cron.schedule(
  'mailcaster-check-replies',
  '*/5 * * * *',
  $cronbody$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
          FROM vault.decrypted_secrets
         WHERE name = 'mailcaster_project_url'
      ) || '/functions/v1/check-replies',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
            FROM vault.decrypted_secrets
           WHERE name = 'mailcaster_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $cronbody$
);
