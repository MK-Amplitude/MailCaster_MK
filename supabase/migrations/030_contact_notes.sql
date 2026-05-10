-- =============================================
-- Phase 10 — 연락처별 수동 기록 (통화 / 미팅 / 메모)
-- ---------------------------------------------
-- 메일은 채널 1개일 뿐. 오프라인 영업의 진짜 컨텍스트는 통화/미팅/내부 메모.
-- 연락처 detail sheet 의 timeline 에서 메일 발송 이력과 합쳐 시간순 표시.
--
-- 테이블 디자인:
--   - kind: call / meeting / note (자유 텍스트 분류는 나중에 tag 로 확장 가능)
--   - body: 자유 텍스트 (어떤 얘기가 오갔는지)
--   - occurred_at: 실제 통화/미팅 시각. 사용자가 입력 (기본값=now()).
--                  created_at 과 분리 — "어제 통화한 걸 오늘 기록" 같은 케이스.
--
-- 보안 (RLS):
--   - SELECT: 같은 org 의 멤버 누구나 (영업팀 공유)
--   - INSERT: 본인 user_id 로만, 본인이 속한 org 의 contact 에만
--   - UPDATE/DELETE: 본인이 작성한 노트만 (다른 사람 메모 수정 X)
-- =============================================

CREATE TABLE IF NOT EXISTS mailcaster.contact_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES mailcaster.contacts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES mailcaster.profiles(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'meeting', 'note')),
  body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 5000),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

-- timeline 정렬용 — 같은 연락처 안에서 시간순 (DESC)
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact_occurred
  ON mailcaster.contact_notes (contact_id, occurred_at DESC);

-- org 별 최근 활동 피드 등 — 향후 확장 대비
CREATE INDEX IF NOT EXISTS idx_contact_notes_org_occurred
  ON mailcaster.contact_notes (org_id, occurred_at DESC);

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION mailcaster.tg_contact_notes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contact_notes_updated_at ON mailcaster.contact_notes;
CREATE TRIGGER contact_notes_updated_at
  BEFORE UPDATE ON mailcaster.contact_notes
  FOR EACH ROW
  EXECUTE FUNCTION mailcaster.tg_contact_notes_updated_at();

-- ------------------------------------------------------------
-- RLS 정책
-- ------------------------------------------------------------
ALTER TABLE mailcaster.contact_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contact_notes: org members read"   ON mailcaster.contact_notes;
DROP POLICY IF EXISTS "contact_notes: own insert"         ON mailcaster.contact_notes;
DROP POLICY IF EXISTS "contact_notes: own update"         ON mailcaster.contact_notes;
DROP POLICY IF EXISTS "contact_notes: own delete"         ON mailcaster.contact_notes;

-- 같은 org 의 모든 멤버가 SELECT 가능 (영업팀 협업)
CREATE POLICY "contact_notes: org members read"
  ON mailcaster.contact_notes FOR SELECT
  TO authenticated
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

-- INSERT — 자기 user_id 로만, 자기 org 안의 노트만
CREATE POLICY "contact_notes: own insert"
  ON mailcaster.contact_notes FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

-- UPDATE — 본인 노트만 수정 가능
CREATE POLICY "contact_notes: own update"
  ON mailcaster.contact_notes FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND org_id IN (SELECT mailcaster.user_org_ids()));

-- DELETE — 본인 노트만
CREATE POLICY "contact_notes: own delete"
  ON mailcaster.contact_notes FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON mailcaster.contact_notes TO authenticated, service_role;
