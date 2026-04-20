-- =============================================
-- Phase 8 — unsubscribes / blacklist 를 조직 단위로 승격
-- ---------------------------------------------
-- 이유:
--   기존 unsubscribes / blacklist 는 (user_id, email) UNIQUE 로 유저별 개인 목록.
--   → 같은 조직 내 다른 멤버가 발송할 때 중복 컨택/차단 이슈.
--   조직 단위로 공유하면 "조직 전체에서 한 번 차단 = 모든 멤버 발송에서 제외" 를 보장.
--
-- 원칙:
--   SELECT : 조직 멤버 전원이 조회 가능 (org_id IN user_org_ids())
--   INSERT : user_id = auth.uid() AND 내가 속한 조직 (등록자 추적 유지)
--   UPDATE/DELETE : 본인 기록 OR org admin (오등록 수정권)
--
-- 마이그레이션 전략:
--   1. ADD COLUMN org_id NULL
--   2. org_members 조인으로 기존 row 에 org_id 백필
--      (유저당 여러 조직일 경우 joined_at 가장 오래된 조직 선택 — 보통 개인 워크스페이스)
--   3. (org_id, email) 충돌 dedupe (가장 오래된 row 유지)
--   4. 기존 UNIQUE(user_id, email) DROP → UNIQUE(org_id, email) ADD
--   5. NOT NULL + FK + 인덱스
--   6. 기존 RLS 정책 DROP → 조직 기반 정책 CREATE
--
-- 호환성:
--   - user_id 컬럼은 그대로 유지 (등록자 추적) — 프런트/Edge Fn 은 점진적으로 org_id 도 함께 저장.
--   - 발송 경로(useSendCampaign) 가 unsubscribes 를 조회하는 방식은 RLS 가 알아서 처리 —
--     조직 멤버이면 조직 전체 unsubscribes 가 보여서 자동으로 필터링됨.
-- =============================================

-- =============================================
-- 1. org_id 컬럼 추가 (nullable)
-- =============================================
ALTER TABLE mailcaster.unsubscribes ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE mailcaster.blacklist    ADD COLUMN IF NOT EXISTS org_id UUID;

-- =============================================
-- 2. 백필 — 유저의 primary org (가장 오래된 멤버십) 로 설정
-- ---------------------------------------------
-- 014 에서 모든 기존 유저에 개인 워크스페이스를 생성했으므로,
-- org_members 에 최소 한 개 row 가 존재한다고 가정.
-- 외래키 ON DELETE CASCADE 이므로 고아 row 는 없음.
-- =============================================
UPDATE mailcaster.unsubscribes u
SET org_id = primary_org.org_id
FROM (
  SELECT DISTINCT ON (user_id) user_id, org_id
  FROM mailcaster.org_members
  ORDER BY user_id, joined_at ASC
) primary_org
WHERE u.user_id = primary_org.user_id
  AND u.org_id IS NULL;

UPDATE mailcaster.blacklist b
SET org_id = primary_org.org_id
FROM (
  SELECT DISTINCT ON (user_id) user_id, org_id
  FROM mailcaster.org_members
  ORDER BY user_id, joined_at ASC
) primary_org
WHERE b.user_id = primary_org.user_id
  AND b.org_id IS NULL;

-- =============================================
-- 3. (org_id, email) 충돌 dedupe
-- ---------------------------------------------
-- 같은 조직에 속한 여러 유저가 같은 email 을 개별적으로 unsubscribe/blacklist 한 경우,
-- 새 UNIQUE(org_id, email) 에 위배. 가장 오래된 것 1개만 남김.
-- id 는 UUID 라 tiebreaker 로 씀 (타임스탬프 동일 시 deterministic).
-- =============================================
DELETE FROM mailcaster.unsubscribes
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, email
        ORDER BY unsubscribed_at ASC, id ASC
      ) AS rn
    FROM mailcaster.unsubscribes
  ) t
  WHERE t.rn > 1
);

DELETE FROM mailcaster.blacklist
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, email
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM mailcaster.blacklist
  ) t
  WHERE t.rn > 1
);

-- =============================================
-- 4. 기존 UNIQUE 제약 DROP
-- ---------------------------------------------
-- 001 에서 명시적 이름 없이 생성 → Postgres 기본 naming: {table}_{cols}_key.
-- =============================================
ALTER TABLE mailcaster.unsubscribes DROP CONSTRAINT IF EXISTS unsubscribes_user_id_email_key;
ALTER TABLE mailcaster.blacklist    DROP CONSTRAINT IF EXISTS blacklist_user_id_email_key;

-- =============================================
-- 5. NOT NULL + FK + 새 UNIQUE
-- =============================================
ALTER TABLE mailcaster.unsubscribes
  ALTER COLUMN org_id SET NOT NULL,
  ADD CONSTRAINT unsubscribes_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  ADD CONSTRAINT unsubscribes_org_id_email_key UNIQUE (org_id, email);

ALTER TABLE mailcaster.blacklist
  ALTER COLUMN org_id SET NOT NULL,
  ADD CONSTRAINT blacklist_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  ADD CONSTRAINT blacklist_org_id_email_key UNIQUE (org_id, email);

-- =============================================
-- 6. 인덱스 (RLS `org_id IN (...)` 성능)
-- =============================================
CREATE INDEX IF NOT EXISTS idx_unsubscribes_org_id ON mailcaster.unsubscribes(org_id);
CREATE INDEX IF NOT EXISTS idx_blacklist_org_id    ON mailcaster.blacklist(org_id);

-- =============================================
-- 7. 기존 RLS 정책 DROP
-- =============================================
DROP POLICY IF EXISTS "unsubscribes: own" ON mailcaster.unsubscribes;
DROP POLICY IF EXISTS "blacklist: own"    ON mailcaster.blacklist;

-- =============================================
-- 8. unsubscribes — 조직 기반 RLS
-- =============================================
CREATE POLICY "unsubscribes_select_org" ON mailcaster.unsubscribes
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

CREATE POLICY "unsubscribes_insert_own" ON mailcaster.unsubscribes
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "unsubscribes_update_own_or_admin" ON mailcaster.unsubscribes
  FOR UPDATE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
  WITH CHECK (
    (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "unsubscribes_delete_own_or_admin" ON mailcaster.unsubscribes
  FOR DELETE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id));

-- =============================================
-- 9. blacklist — 조직 기반 RLS (같은 패턴)
-- =============================================
CREATE POLICY "blacklist_select_org" ON mailcaster.blacklist
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

CREATE POLICY "blacklist_insert_own" ON mailcaster.blacklist
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "blacklist_update_own_or_admin" ON mailcaster.blacklist
  FOR UPDATE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
  WITH CHECK (
    (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "blacklist_delete_own_or_admin" ON mailcaster.blacklist
  FOR DELETE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id));
