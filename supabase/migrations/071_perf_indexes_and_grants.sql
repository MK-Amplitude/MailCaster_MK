-- 071_perf_indexes_and_grants.sql
-- =====================================================================
-- 전체 코드 감사에서 발견된 성능 인덱스 보강 + 권한 정리 (동작 변경 없음)
-- =====================================================================

-- 1) inbox_stats RPC (060) / analytics RPC (066) 의 sent_at 범위 조건 커버.
--    useInboxStats 가 60초마다 폴링하는데 org_id + sent_at 를 커버하는 인덱스가 없어
--    발송 이력이 쌓일수록 전체 스캔 비용이 무한 증가하던 문제.
CREATE INDEX IF NOT EXISTS idx_thread_messages_org_sent_at
  ON mailcaster.thread_messages (org_id, sent_at DESC)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_recipients_campaign_sent_at
  ON mailcaster.recipients (campaign_id, sent_at DESC)
  WHERE status IN ('sent', 'bounced');

-- 2) open_events.recipient_id — ON DELETE CASCADE FK 인데 인덱스가 없어
--    recipient/campaign 삭제 시 open_events 순차 스캔이 발생하던 문제.
CREATE INDEX IF NOT EXISTS idx_open_events_recipient
  ON mailcaster.open_events (recipient_id);

-- 3) idx_recipients_reply_check — check-replies 가 bounced=false 로 필터링하는데
--    인덱스 조건에 없어 반송 행이 인덱스 스캔에 포함되던 문제.
--    (053 이 thread_messages 쪽 쌍둥이 인덱스에 한 것과 동일한 보강)
DROP INDEX IF EXISTS mailcaster.idx_recipients_reply_check;
CREATE INDEX idx_recipients_reply_check
  ON mailcaster.recipients (last_reply_check_at NULLS FIRST)
  WHERE status = 'sent' AND gmail_thread_id IS NOT NULL
    AND replied = FALSE AND bounced = FALSE;

-- 4) 방어적 권한 정리 — org 스코프 뷰에 대한 anon SELECT 제거.
--    security_invoker=true + RLS 로 현재도 노출은 없지만 (anon 의 user_org_ids() = 공집합),
--    정확성이 뷰 플래그 하나에만 의존하지 않도록 grant 자체를 회수.
REVOKE SELECT ON mailcaster.contacts_common FROM anon;
REVOKE SELECT ON mailcaster.contact_with_groups FROM anon;
