-- =============================================
-- 081 — pg_cron 실행 기록(cron.job_run_details) 자동 정리
-- ---------------------------------------------
-- 2026-10-19 장애: 2~10분 주기 cron 6종의 실행 기록이 수개월간 삭제되지 않고
-- 603MB(DB 의 91%)까지 쌓여 무료 플랜 DB 한도(500MB)를 넘김 → 프로젝트 사용량 제한,
-- 그리고 pg_cron 의 상태 갱신 UPDATE 가 이 테이블을 매번 전수 스캔해 CPU 97% →
-- 로그인 실패. 실행 기록은 디버깅용 이력일 뿐이므로 3일만 보관한다.
-- (이미 쌓인 데이터의 디스크 회수는 TRUNCATE / VACUUM FULL 로 수동 처리 —
--  VACUUM 은 트랜잭션 안에서 실행할 수 없어 마이그레이션에 넣지 않는다.)
-- =============================================

DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-cleanup-cron-history') THEN
    PERFORM cron.unschedule('mailcaster-cleanup-cron-history');
  END IF;
END
$unsched$;

SELECT cron.schedule(
  'mailcaster-cleanup-cron-history',
  '17 3 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '3 days'$$
);
