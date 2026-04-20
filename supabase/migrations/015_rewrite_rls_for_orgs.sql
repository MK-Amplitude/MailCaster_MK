-- =============================================
-- Phase 7 — RLS 재작성 (org 기반)
-- ---------------------------------------------
-- 원칙:
--   SELECT : 조직 멤버 전원이 조회 가능 (org_id IN user_org_ids())
--   INSERT : user_id = auth.uid() AND org_id 은 내가 속한 조직
--   UPDATE : 본인 리소스 OR org admin(=owner/admin)
--   DELETE : 본인 리소스 OR org admin
--
-- 파생 테이블 (contact_groups, campaign_groups, recipients, ...):
--   상위 테이블의 RLS 를 transitively 따른다 — EXISTS 서브쿼리로 위임.
--
-- 유지:
--   unsubscribes / blacklist / slack_notifications → user_id 기반 (개인 기록)
--   → 향후 조직 전체 unsubscribe 로 승격할 때 별도 마이그레이션
-- =============================================

-- =============================================
-- 1. 기존 정책 DROP
-- =============================================
DROP POLICY IF EXISTS "contacts: own"             ON mailcaster.contacts;
DROP POLICY IF EXISTS "group_categories: own"     ON mailcaster.group_categories;
DROP POLICY IF EXISTS "groups: own"               ON mailcaster.groups;
DROP POLICY IF EXISTS "contact_groups: own"       ON mailcaster.contact_groups;
DROP POLICY IF EXISTS "templates: own"            ON mailcaster.templates;
DROP POLICY IF EXISTS "signatures: own"           ON mailcaster.signatures;
DROP POLICY IF EXISTS "campaigns: own"            ON mailcaster.campaigns;
DROP POLICY IF EXISTS "campaign_groups: own"      ON mailcaster.campaign_groups;
DROP POLICY IF EXISTS "recipients: own"           ON mailcaster.recipients;
DROP POLICY IF EXISTS "followup_steps: own"       ON mailcaster.followup_steps;
DROP POLICY IF EXISTS "followup_logs: own"        ON mailcaster.followup_logs;
DROP POLICY IF EXISTS "open_events: own"          ON mailcaster.open_events;
-- NOTE: 단일 `attachments` 테이블은 004 에서 DROP 되고 drive_attachments /
--        campaign_attachments / recipient_attachments / template_attachments 로 분리됨.
--        이 마이그레이션에서 해당 테이블은 건드리지 않음 (분리 테이블의 RLS 는 별도 필요 시 추후 추가).
DROP POLICY IF EXISTS "send_logs: own"            ON mailcaster.send_logs;

-- =============================================
-- 2. contacts
-- =============================================
CREATE POLICY "contacts_select_org" ON mailcaster.contacts
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

CREATE POLICY "contacts_insert_own" ON mailcaster.contacts
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "contacts_update_own_or_admin" ON mailcaster.contacts
  FOR UPDATE
  USING (
    user_id = auth.uid()
    OR mailcaster.user_is_org_admin(org_id)
  )
  WITH CHECK (
    (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "contacts_delete_own_or_admin" ON mailcaster.contacts
  FOR DELETE
  USING (
    user_id = auth.uid()
    OR mailcaster.user_is_org_admin(org_id)
  );

-- =============================================
-- 3. group_categories
-- =============================================
CREATE POLICY "group_categories_select_org" ON mailcaster.group_categories
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

CREATE POLICY "group_categories_insert_own" ON mailcaster.group_categories
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "group_categories_update_own_or_admin" ON mailcaster.group_categories
  FOR UPDATE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
  WITH CHECK (
    (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "group_categories_delete_own_or_admin" ON mailcaster.group_categories
  FOR DELETE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id));

-- =============================================
-- 4. groups
-- =============================================
CREATE POLICY "groups_select_org" ON mailcaster.groups
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

CREATE POLICY "groups_insert_own" ON mailcaster.groups
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "groups_update_own_or_admin" ON mailcaster.groups
  FOR UPDATE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
  WITH CHECK (
    (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "groups_delete_own_or_admin" ON mailcaster.groups
  FOR DELETE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id));

-- =============================================
-- 5. contact_groups (junction) — contacts/groups RLS 를 transitively 따름
-- ---------------------------------------------
-- 같은 조직의 연락처를 같은 조직의 그룹에 연결/해제 — 모든 멤버 가능.
-- SELECT 할 때 EXISTS (contact 은 조직 내 조회 가능) 로 필터링.
-- =============================================
CREATE POLICY "contact_groups_select_visible" ON mailcaster.contact_groups
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM mailcaster.contacts c WHERE c.id = contact_id)
  );

CREATE POLICY "contact_groups_insert_visible" ON mailcaster.contact_groups
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM mailcaster.contacts c WHERE c.id = contact_id)
    AND EXISTS (SELECT 1 FROM mailcaster.groups g  WHERE g.id = group_id)
  );

CREATE POLICY "contact_groups_delete_visible" ON mailcaster.contact_groups
  FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM mailcaster.contacts c WHERE c.id = contact_id)
  );

-- =============================================
-- 6. templates
-- =============================================
CREATE POLICY "templates_select_org" ON mailcaster.templates
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

CREATE POLICY "templates_insert_own" ON mailcaster.templates
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "templates_update_own_or_admin" ON mailcaster.templates
  FOR UPDATE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
  WITH CHECK (
    (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "templates_delete_own_or_admin" ON mailcaster.templates
  FOR DELETE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id));

-- =============================================
-- 7. signatures
-- ---------------------------------------------
-- 조직 내 서명은 모두 보임 (서로 참고/카피 가능하게).
-- 본인 서명만 편집/삭제 가능. default 는 본인 기준 단일 유지.
-- =============================================
CREATE POLICY "signatures_select_org" ON mailcaster.signatures
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

CREATE POLICY "signatures_insert_own" ON mailcaster.signatures
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "signatures_update_own" ON mailcaster.signatures
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "signatures_delete_own" ON mailcaster.signatures
  FOR DELETE
  USING (user_id = auth.uid());

-- =============================================
-- 8. campaigns
-- ---------------------------------------------
-- 조직 전체가 조회 가능 (협업). 본인 캠페인만 수정/삭제.
-- 발송 실행은 기존처럼 campaigns.user_id 소유자의 Gmail 로 (Edge Fn 은 변경 없음).
-- =============================================
CREATE POLICY "campaigns_select_org" ON mailcaster.campaigns
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

CREATE POLICY "campaigns_insert_own" ON mailcaster.campaigns
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "campaigns_update_own_or_admin" ON mailcaster.campaigns
  FOR UPDATE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
  WITH CHECK (
    (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id))
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

CREATE POLICY "campaigns_delete_own_or_admin" ON mailcaster.campaigns
  FOR DELETE
  USING (user_id = auth.uid() OR mailcaster.user_is_org_admin(org_id));

-- =============================================
-- 9. campaign_groups (junction) — campaign/group RLS transitively
-- =============================================
CREATE POLICY "campaign_groups_select_visible" ON mailcaster.campaign_groups
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  );

CREATE POLICY "campaign_groups_insert_visible" ON mailcaster.campaign_groups
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
    AND EXISTS (SELECT 1 FROM mailcaster.groups g WHERE g.id = group_id)
  );

CREATE POLICY "campaign_groups_delete_visible" ON mailcaster.campaign_groups
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  );

-- =============================================
-- 10. recipients — 조직 멤버 모두 조회/수정 가능 (통계 보기, 발송 자동화)
-- =============================================
CREATE POLICY "recipients_all_visible" ON mailcaster.recipients
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  );

-- =============================================
-- 11. followup_steps / followup_logs
-- =============================================
CREATE POLICY "followup_steps_all_visible" ON mailcaster.followup_steps
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  );

CREATE POLICY "followup_logs_all_visible" ON mailcaster.followup_logs
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM mailcaster.recipients r WHERE r.id = recipient_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM mailcaster.recipients r WHERE r.id = recipient_id)
  );

-- =============================================
-- 12. open_events / send_logs
-- ---------------------------------------------
-- 단일 `attachments` 는 004 에서 제거 → drive_attachments 등 분리 테이블로 대체.
-- 분리된 첨부 테이블의 org-기반 RLS 는 필요 시 별도 마이그레이션으로 추가.
-- =============================================
CREATE POLICY "open_events_all_visible" ON mailcaster.open_events
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  );

CREATE POLICY "send_logs_all_visible" ON mailcaster.send_logs
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  );
