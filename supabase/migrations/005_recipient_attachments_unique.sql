-- =============================================
-- recipient_attachments 중복 이력 방지
--
-- 배경: 발송 로직의 재시도 경로(재발송/복구 등) 에서 동일한 (attachment, recipient, campaign)
--       조합이 여러 번 insert 될 여지가 있다. 이력 뷰(attachment_send_stats) 의
--       COUNT(ra.id) / COUNT(DISTINCT recipient_email/campaign_id) 가 부풀려지지 않도록
--       유니크 제약을 건다.
--
-- 주의: 이미 중복이 있는 DB 에서는 UNIQUE 생성이 실패한다. 실행 전에 중복 레코드를
--       정리하거나, 본 마이그레이션 맨 위의 DELETE 블록을 활성화해 (attachment_id,
--       recipient_id, campaign_id) 기준으로 가장 오래된 id 하나만 남기고 제거한다.
-- =============================================

-- (선택) 기존 중복 제거 — 배포 전 데이터 상태 확인 후 필요하면 주석 해제
-- DELETE FROM mailcaster.recipient_attachments a
-- USING mailcaster.recipient_attachments b
-- WHERE a.ctid < b.ctid
--   AND a.attachment_id = b.attachment_id
--   AND a.recipient_id IS NOT DISTINCT FROM b.recipient_id
--   AND a.campaign_id IS NOT DISTINCT FROM b.campaign_id;

-- recipient_id / campaign_id 가 NULL 일 수 있으므로 일반 UNIQUE 대신
-- 부분(partial) 유니크 인덱스 2개로 분리 — NULL 은 UNIQUE 에서 "다른 값" 으로 간주되지만
-- 이 도메인에서는 동일한 NULL 조합은 중복으로 취급해야 한다.
--
-- 실제 시나리오:
--   1) recipient_id, campaign_id 둘 다 존재 (정상 이력) → 가장 흔한 경로
--   2) recipient_id NULL (수신자 행 삭제됨), campaign_id 존재 → 보존된 이력
--   3) recipient_id 존재, campaign_id NULL (캠페인 삭제됨) → 드물지만 가능
--   4) 둘 다 NULL (완전 고아) → 극단적
-- 1) 만 강제 UNIQUE 로 막는다. 2~4) 는 상대적으로 드물고 이미 "보존됨" 상태라 추가
-- 방지 가치가 낮음.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipient_attachments_alive
  ON mailcaster.recipient_attachments (attachment_id, recipient_id, campaign_id)
  WHERE recipient_id IS NOT NULL AND campaign_id IS NOT NULL;
