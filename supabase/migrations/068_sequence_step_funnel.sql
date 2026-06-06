-- =============================================
-- 고도화 Tier 3-b — 시퀀스 스텝별 전환 퍼널
-- ---------------------------------------------
-- 시퀀스 발송(thread_messages)을 어느 시퀀스/스텝에서 나왔는지 링크해, 스텝별
-- 발송/오픈/회신을 집계한다. "몇 번째 후속에서 회신이 나오는가 / 어디서 이탈하는가" 분석.
-- =============================================

ALTER TABLE mailcaster.thread_messages
  ADD COLUMN IF NOT EXISTS sequence_id UUID REFERENCES mailcaster.sequences(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sequence_step_order INT;

CREATE INDEX IF NOT EXISTS idx_thread_messages_sequence
  ON mailcaster.thread_messages (sequence_id, sequence_step_order)
  WHERE sequence_id IS NOT NULL;

COMMENT ON COLUMN mailcaster.thread_messages.sequence_id IS
  '이 발송이 어느 시퀀스에서 나왔는지 (process-sequences 가 기록). 스텝 퍼널 분석용.';
COMMENT ON COLUMN mailcaster.thread_messages.sequence_step_order IS
  '시퀀스 스텝 순서 (process-sequences 가 기록).';

-- 스텝별 퍼널 — sent/opened/replied. org 멤버만 (해당 시퀀스가 내 org 인지 검증).
CREATE OR REPLACE FUNCTION mailcaster.sequence_step_funnel(p_sequence_id UUID)
RETURNS TABLE (step_order INT, sent BIGINT, opened BIGINT, replied BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
  SELECT
    tm.sequence_step_order AS step_order,
    COUNT(*) FILTER (WHERE tm.status = 'sent') AS sent,
    COUNT(*) FILTER (WHERE tm.status = 'sent' AND tm.opened) AS opened,
    COUNT(*) FILTER (WHERE tm.status = 'sent' AND tm.replied) AS replied
  FROM mailcaster.thread_messages tm
  WHERE tm.sequence_id = p_sequence_id
    AND tm.sequence_step_order IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM mailcaster.sequences s
       WHERE s.id = p_sequence_id
         AND s.org_id IN (SELECT mailcaster.user_org_ids())
    )
  GROUP BY tm.sequence_step_order
  ORDER BY tm.sequence_step_order;
$$;

REVOKE ALL ON FUNCTION mailcaster.sequence_step_funnel(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.sequence_step_funnel(UUID) TO authenticated;

COMMENT ON FUNCTION mailcaster.sequence_step_funnel IS
  '시퀀스 스텝별 발송/오픈/회신 집계 (Tier 3-b). org 멤버 검증 포함.';
