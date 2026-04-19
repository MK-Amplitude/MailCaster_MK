-- =============================================
-- Phase 3: 캠페인 블록 (여러 템플릿 조합 발송)
-- =============================================

-- 1) campaign_blocks — 캠페인에 연결된 템플릿 블록 목록
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS mailcaster.campaign_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES mailcaster.templates(id) ON DELETE RESTRICT,
  position INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_campaign_blocks_campaign
  ON mailcaster.campaign_blocks (campaign_id, position);

ALTER TABLE mailcaster.campaign_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaign_blocks: own" ON mailcaster.campaign_blocks;
CREATE POLICY "campaign_blocks: own" ON mailcaster.campaign_blocks
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM mailcaster.campaigns c
      WHERE c.id = campaign_blocks.campaign_id AND c.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM mailcaster.campaigns c
      WHERE c.id = campaign_blocks.campaign_id AND c.user_id = auth.uid()
    )
  );
