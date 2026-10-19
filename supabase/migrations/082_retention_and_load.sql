-- =============================================
-- 082 — 보존 정책(retention) + cron 부하 경감 + 공유 프로젝트 가입 안전성
-- ---------------------------------------------
-- 2026-10-19 장애(cron.job_run_details 603MB → 무료 500MB 한도 초과, CPU 97%) 후속
-- 헬스 리뷰. 무료 플랜 / nano 컴퓨트 / Lumvo 와 같은 프로젝트를 공유하므로
-- "지우는 로직이 없는 테이블" 과 "불필요한 쓰기" 를 함께 정리한다.
--
-- 1) 인덱스
--    · thread_messages (created_at) WHERE status='pending'
--      reconcile_stale_thread_messages()(054, */10) 의 3개 UPDATE 가 모두
--      `status='pending' AND created_at < NOW() - 10분` — 매 실행 순차 스캔 3회 제거.
--    · recipients (sent_at) — check-replies pass1 (status='sent', gmail_thread_id NOT NULL,
--      replied=FALSE, bounced=FALSE, sent_at >= now()-30일) 용. 기존
--      idx_recipients_reply_check(last_reply_check_at) 는 30일 지난 미회신 행이
--      정렬 앞쪽에 영구히 쌓여 매 tick 힙에서 읽고 버림 → sent_at 범위로 30일분만 읽게 함.
--      (last_reply_check_at 은 idx_recipients_thread_recheck 키라 원래 HOT 불가 —
--       이 인덱스 추가로 HOT 가능성이 새로 사라지지는 않음)
--    · inbound_messages (received_at) WHERE body_html IS NOT NULL — 90일 body 비우기용.
--      비운 행은 인덱스에서 빠지므로 거의 빈 인덱스로 유지됨.
--
-- 2) audit_log 트리거 축소 (035/037)
--    발송 워커가 수신자 1명마다 campaigns 진행 컬럼(sending_started_at lease, sent_count,
--    failed_count, last_processed_recipient_id, send_attempts …)을 UPDATE → 매번
--    to_jsonb(OLD/NEW)(body_html 포함) 2회 + audit_log 1행. campaigns 의 UPDATE 트리거만
--    `AFTER UPDATE OF <의미 있는 컬럼> … WHEN (실제 변경)` 으로 분리:
--      · SET 목록에 해당 컬럼이 없으면 트리거 자체가 발화하지 않음 (WHEN 평가도 생략)
--      · SET 목록에 있어도 값이 같으면 WHEN 에서 걸러져 to_jsonb 변환 없음
--    INSERT/DELETE 와 다른 테이블(contacts/groups/signatures/templates) 동작은 그대로.
--
-- 3) handle_new_user (001) 예외 안전화 — auth.users 는 Lumvo 와 공유.
--    이 트리거(와 그 안에서 이어지는 profiles → trg_create_personal_org(016))가 실패하면
--    auth.users INSERT 가 롤백돼 Lumvo 가입까지 막힘 ('Database error saving new user').
--    → EXCEPTION 블록으로 감싸 WARNING 만 남기고 RETURN NEW.
--      블록은 서브트랜잭션이라 실패 시 profiles/organizations/org_members/group_categories
--      가 함께 롤백됨(반쪽 상태 없음). MailCaster 사용자는 다음 로그인 때 AuthContext 의
--      profiles upsert(INSERT) 가 trg_create_personal_org 를 다시 태워 자동 복구.
--    create_personal_org_for_new_profile(016) 는 의도적으로 그대로 둠 — 거기서 예외를
--    삼키면 org 없는 profile 이 남고 이후 upsert 는 UPDATE 라 영영 복구되지 않음.
--    auth.users 경로의 실패는 위 handle_new_user 블록이 모두 흡수한다.
--
-- 4) mailcaster.run_retention() + 일일 cron 'mailcaster-retention' (03:37 UTC)
--    테이블별 최대 p_batch(기본 5000)행씩 — 한 번의 실행이 nano CPU 를 오래 잡지 않게.
--    섹션별 EXCEPTION 블록 — 한 테이블 실패가 다른 정리를 롤백하지 않음 (errors 에 기록).
--      · inbound_messages : 90일 지난 body_html → NULL / 100,000 바이트 초과 body_html → NULL
--                           (check-inbox 의 BODY_HTML_MAX_BYTES 와 동일 기준) / 365일 지난 행 삭제
--                           (inbound_messages 를 참조하는 FK 없음. inbox_stats 는 30일 창,
--                            check-inbox dedup 은 커서 이후 메시지만 조회하므로 재수집 없음)
--      · audit_log        : 180일
--      · open_events / click_events : 180일 — 화면/분석 집계는 recipients·thread_messages
--                           의 opened/open_count/clicked/click_count 컬럼에서 읽음
--                           (066/068 RPC·프런트 어디도 이벤트 원본을 조회하지 않음)
--      · contact_history  : 365일
--      · unsubscribe_tokens : 위저드 편집으로 지워진 미발송 recipients 의 고아 토큰만.
--                           campaign_id 가 NULL(캠페인 삭제)인 토큰은 발송된 메일 링크 보존용이라
--                           절대 지우지 않음. 추가로 "캠페인에서 한 통도 발송된 흔적이 없을 때"만
--                           삭제 — 발송된 수신자 행이 REST 로 직접 지워진 경우에도 링크 유지.
--    thread_message_replies 는 실제 회신 본문(스레드 화면 표시)이라 보존 대상에서 제외.
--
-- 5) cron.job_run_details 정리(081) 재정의 — end_time 이 NULL 인 행(재시작/고갈로
--    starting·running 에 멈춘 실행)도 지우도록 coalesce(end_time, start_time) 기준
--    (start_time 까지 NULL 인 'starting' 행은 runid 순서로 판정).
--    run_retention 에 합치지 않고 081 job 을 그대로 재정의 — 장애 원인 테이블 정리는
--    다른 정리의 성공 여부와 무관하게 단독으로 돌아야 하므로 (정리 경로는 이 job 하나뿐).
--    jobid 필터 없음 = Lumvo job 기록도 3일 보관 (같은 DB 한도를 공유하므로 의도된 동작).
--
-- 6) 일회성 백필 — 100,000 바이트 초과 inbound body_html → NULL (최대 50,000행, 나머지는
--    일일 run_retention 이 이어서 처리). octet_length 는 TOAST 값을 풀지 않고 원본 크기를 읽음.
--
-- 디스크 회수: NULL/DELETE 로 생긴 빈 공간은 autovacuum 후 재사용됨. OS 로 돌려주려면
-- 대시보드 SQL Editor 에서 VACUUM FULL 을 수동 실행 (트랜잭션 안에서 실행 불가라 여기 없음).
--
-- 모든 함수: SECURITY DEFINER + SET search_path = mailcaster, public (076 정책).
-- 멱등 — 재실행 안전.
-- =============================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) 인덱스
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_thread_messages_pending
  ON mailcaster.thread_messages (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_recipients_reply_check_sent_at
  ON mailcaster.recipients (sent_at)
  WHERE status = 'sent' AND gmail_thread_id IS NOT NULL
    AND replied = FALSE AND bounced = FALSE;

CREATE INDEX IF NOT EXISTS idx_inbound_messages_body_html_received
  ON mailcaster.inbound_messages (received_at)
  WHERE body_html IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) campaigns audit 트리거 — 의미 있는 컬럼 변경만 기록
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_campaigns ON mailcaster.campaigns;
CREATE TRIGGER audit_campaigns
  AFTER INSERT OR DELETE ON mailcaster.campaigns
  FOR EACH ROW EXECUTE FUNCTION mailcaster.tg_audit_log();

-- 진행/운영 컬럼(sent_count, failed_count, open_count, reply_count, click_count, …,
-- sending_started_at, last_processed_recipient_id, send_attempts, last_error, total_count,
-- draft_data, last_saved_at) 만 바뀐 UPDATE 는 발화하지 않음.
-- user_id / org_id 는 소유권 이동이라 함께 기록.
DROP TRIGGER IF EXISTS audit_campaigns_update ON mailcaster.campaigns;
CREATE TRIGGER audit_campaigns_update
  AFTER UPDATE OF
    name, subject, body_html, status, scheduled_at, cc, bcc,
    signature_id, template_id, send_mode, followup_sequence_id,
    include_unsubscribe_link, enable_open_tracking, user_id, org_id
  ON mailcaster.campaigns
  FOR EACH ROW
  WHEN (
       OLD.name                     IS DISTINCT FROM NEW.name
    OR OLD.subject                  IS DISTINCT FROM NEW.subject
    OR OLD.status                   IS DISTINCT FROM NEW.status
    OR OLD.scheduled_at             IS DISTINCT FROM NEW.scheduled_at
    OR OLD.cc                       IS DISTINCT FROM NEW.cc
    OR OLD.bcc                      IS DISTINCT FROM NEW.bcc
    OR OLD.signature_id             IS DISTINCT FROM NEW.signature_id
    OR OLD.template_id              IS DISTINCT FROM NEW.template_id
    OR OLD.send_mode                IS DISTINCT FROM NEW.send_mode
    OR OLD.followup_sequence_id     IS DISTINCT FROM NEW.followup_sequence_id
    OR OLD.include_unsubscribe_link IS DISTINCT FROM NEW.include_unsubscribe_link
    OR OLD.enable_open_tracking     IS DISTINCT FROM NEW.enable_open_tracking
    OR OLD.user_id                  IS DISTINCT FROM NEW.user_id
    OR OLD.org_id                   IS DISTINCT FROM NEW.org_id
    -- body_html 은 마지막 — 앞 조건이 참이면 대용량 본문 비교를 건너뜀
    OR OLD.body_html                IS DISTINCT FROM NEW.body_html
  )
  EXECUTE FUNCTION mailcaster.tg_audit_log();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) handle_new_user — auth.users INSERT 를 절대 막지 않도록 예외 안전화
--    (본문 동작은 001 과 동일. CREATE OR REPLACE 라 076 의 권한 회수 상태 유지)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    INSERT INTO mailcaster.profiles (id, email, display_name)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1))
    )
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- 공유 프로젝트(Lumvo) 가입을 막지 않는다. profiles 와 trg_create_personal_org 가 만든
    -- 행은 이 서브트랜잭션과 함께 롤백 → MailCaster 로그인 시 profiles upsert 가 재시도.
    RAISE WARNING '[mailcaster] handle_new_user 실패 — auth.users INSERT 는 계속 진행 (user_id=%, sqlstate=%): %',
      NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = mailcaster, public;
-- 권한은 건드리지 않음 — CREATE OR REPLACE 는 기존 ACL(076 회수 상태)을 그대로 유지하며,
-- 가입 경로(supabase_auth_admin)에 영향을 줄 수 있는 변경은 이 마이그레이션에서 피한다.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) run_retention — 일일 보존 정리 (service_role / cron 전용)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.run_retention(p_batch INT DEFAULT 5000)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
-- 사용자 요청과 행 락이 겹치면 오래 기다리지 않고 해당 섹션만 건너뜀 (errors 에 기록)
SET lock_timeout = '5s'
AS $$
DECLARE
  v_batch   INT := LEAST(GREATEST(COALESCE(p_batch, 5000), 1), 50000);
  v_n       INT;
  v_summary JSONB := '{}'::jsonb;
  v_errors  JSONB := '{}'::jsonb;
BEGIN
  -- 4-1) inbound_messages — 365일 지난 행 삭제 (참조 FK 없음)
  BEGIN
    DELETE FROM mailcaster.inbound_messages
     WHERE id IN (
       SELECT id FROM mailcaster.inbound_messages
        WHERE received_at < now() - interval '365 days'
        LIMIT v_batch
     );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_summary := v_summary || jsonb_build_object('inbound_deleted', v_n);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('inbound_deleted', SQLERRM);
  END;

  -- 4-2) inbound_messages — 90일 지난 body_html 비우기 (UI 는 body_text/snippet 만 사용)
  BEGIN
    UPDATE mailcaster.inbound_messages
       SET body_html = NULL
     WHERE id IN (
       SELECT id FROM mailcaster.inbound_messages
        WHERE body_html IS NOT NULL
          AND received_at < now() - interval '90 days'
        LIMIT v_batch
     );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_summary := v_summary || jsonb_build_object('inbound_body_nulled_old', v_n);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('inbound_body_nulled_old', SQLERRM);
  END;

  -- 4-3) inbound_messages — 100,000 바이트 초과 body_html 비우기
  --      (check-inbox 저장 상한과 동일. 082 이전 수집분 잔여 처리. octet_length 는 TOAST 를 풀지 않음)
  BEGIN
    UPDATE mailcaster.inbound_messages
       SET body_html = NULL
     WHERE id IN (
       SELECT id FROM mailcaster.inbound_messages
        WHERE body_html IS NOT NULL
          AND octet_length(body_html) > 100000
        LIMIT v_batch
     );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_summary := v_summary || jsonb_build_object('inbound_body_nulled_large', v_n);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('inbound_body_nulled_large', SQLERRM);
  END;

  -- 4-4) audit_log — 180일
  BEGIN
    DELETE FROM mailcaster.audit_log
     WHERE id IN (
       SELECT id FROM mailcaster.audit_log
        WHERE created_at < now() - interval '180 days'
        LIMIT v_batch
     );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_summary := v_summary || jsonb_build_object('audit_log_deleted', v_n);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('audit_log_deleted', SQLERRM);
  END;

  -- 4-5) open_events — 180일 (집계는 recipients.opened/open_count 등 컬럼에 이미 반영)
  BEGIN
    DELETE FROM mailcaster.open_events
     WHERE id IN (
       SELECT id FROM mailcaster.open_events
        WHERE opened_at < now() - interval '180 days'
        LIMIT v_batch
     );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_summary := v_summary || jsonb_build_object('open_events_deleted', v_n);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('open_events_deleted', SQLERRM);
  END;

  -- 4-6) click_events — 180일 (집계는 recipients/thread_messages.clicked/click_count 컬럼)
  BEGIN
    DELETE FROM mailcaster.click_events
     WHERE id IN (
       SELECT id FROM mailcaster.click_events
        WHERE clicked_at < now() - interval '180 days'
        LIMIT v_batch
     );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_summary := v_summary || jsonb_build_object('click_events_deleted', v_n);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('click_events_deleted', SQLERRM);
  END;

  -- 4-7) contact_history — 365일
  BEGIN
    DELETE FROM mailcaster.contact_history
     WHERE id IN (
       SELECT id FROM mailcaster.contact_history
        WHERE changed_at < now() - interval '365 days'
        LIMIT v_batch
     );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_summary := v_summary || jsonb_build_object('contact_history_deleted', v_n);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('contact_history_deleted', SQLERRM);
  END;

  -- 4-8) unsubscribe_tokens — 위저드 편집으로 사라진 미발송 recipients 의 고아 토큰만.
  --   · campaign_id IS NOT NULL : 캠페인이 살아 있음 (FK ON DELETE SET NULL 이므로 NULL = 삭제된
  --     캠페인 → 이미 발송된 메일의 수신거부 링크 보존용. 절대 삭제하지 않음)
  --   · 매칭 recipients 행 없음 (idx_recipients_unsubscribe_token)
  --   · 그 캠페인에 발송 흔적이 전혀 없음 (sent_count = 0 이고 pending+gmail_message_id NULL 이
  --     아닌 수신자 0명) — 발송된 수신자 행이 직접 삭제된 경우에도 링크 유지
  --   · 생성 1일 경과 — 진행 중인 위저드 저장과 겹치지 않게
  BEGIN
    DELETE FROM mailcaster.unsubscribe_tokens
     WHERE token IN (
       SELECT t.token
         FROM mailcaster.unsubscribe_tokens t
         JOIN mailcaster.campaigns c ON c.id = t.campaign_id
        WHERE t.campaign_id IS NOT NULL
          AND t.created_at < now() - interval '1 day'
          AND COALESCE(c.sent_count, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM mailcaster.recipients r
             WHERE r.unsubscribe_token = t.token
          )
          AND NOT EXISTS (
            SELECT 1 FROM mailcaster.recipients r2
             WHERE r2.campaign_id = c.id
               AND (r2.status IS DISTINCT FROM 'pending' OR r2.gmail_message_id IS NOT NULL)
          )
        LIMIT v_batch
     );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_summary := v_summary || jsonb_build_object('unsubscribe_tokens_deleted', v_n);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('unsubscribe_tokens_deleted', SQLERRM);
  END;

  IF v_errors <> '{}'::jsonb THEN
    RAISE WARNING '[mailcaster] run_retention 일부 실패: %', v_errors;
  END IF;

  RETURN v_summary || jsonb_build_object('batch', v_batch, 'errors', v_errors);
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.run_retention(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.run_retention(INT) TO service_role;

COMMENT ON FUNCTION mailcaster.run_retention(INT) IS
  '일일 보존 정리 (082). inbound body_html 90일/100KB 초과 NULL·행 365일, audit_log 180일, open/click_events 180일, contact_history 365일, 미발송 캠페인 고아 unsubscribe_tokens. 테이블별 최대 p_batch 행. 반환: 섹션별 처리 행 수 + errors. cron 전용.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) 일회성 백필 — 대용량 inbound body_html (컬럼이 있을 때만, 최대 50,000행)
-- ─────────────────────────────────────────────────────────────────────────────
DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'mailcaster'
       AND table_name   = 'inbound_messages'
       AND column_name  = 'body_html'
  ) THEN
    UPDATE mailcaster.inbound_messages
       SET body_html = NULL
     WHERE id IN (
       SELECT id FROM mailcaster.inbound_messages
        WHERE body_html IS NOT NULL
          AND octet_length(body_html) > 100000
        LIMIT 50000
     );
  END IF;
END
$backfill$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) cron — 일일 보존 정리 + 081 실행 기록 정리 재정의
-- ─────────────────────────────────────────────────────────────────────────────
DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-retention') THEN
    PERFORM cron.unschedule('mailcaster-retention');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-cleanup-cron-history') THEN
    PERFORM cron.unschedule('mailcaster-cleanup-cron-history');
  END IF;
END
$unsched$;

SELECT cron.schedule(
  'mailcaster-retention',
  '37 3 * * *',
  $$SELECT mailcaster.run_retention()$$
);

-- end_time 이 NULL 인 행(재시작으로 running 에 멈춘 실행)은 start_time 기준으로 정리.
-- 'starting' 에서 멈춰 start_time 도 NULL 인 행은 runid(단조 증가 시퀀스)로 판정 —
-- 최근 3일 안에 시작된 가장 오래된 실행보다 runid 가 작으면 3일 이상 지난 행.
-- (최근 3일 실행 기록이 하나도 없으면 min() 이 NULL → 이 분기는 아무것도 지우지 않음)
SELECT cron.schedule(
  'mailcaster-cleanup-cron-history',
  '17 3 * * *',
  $$DELETE FROM cron.job_run_details
     WHERE coalesce(end_time, start_time) < now() - interval '3 days'
        OR (end_time IS NULL AND start_time IS NULL
            AND runid < (SELECT min(runid) FROM cron.job_run_details
                          WHERE start_time >= now() - interval '3 days'))$$
);
