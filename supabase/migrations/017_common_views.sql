-- =============================================
-- Phase 7 — 공통(dedupe) 뷰
-- ---------------------------------------------
-- 목적: 같은 조직 내 여러 유저가 각자 등록한 같은 이메일의 연락처를,
--        "공통" 뷰에서 이메일 단위로 하나로 합쳐서 본다/사용한다.
--
-- 사용 예:
--   - 주소록 화면에서 "공통 보기" 토글 → 중복 제거된 목록
--   - 캠페인 수신자 선택 시 중복 제거 (한 이메일에 한 번만 발송)
--
-- 설계:
--   contacts_common : contacts 를 (org_id, LOWER(email)) 로 GROUP BY.
--                     소유자, 이름, 회사 등 대표값 + 전체 owner 목록 집계.
--                     그룹 목록은 모든 소유자의 그룹을 UNION (correlated subquery).
--
-- RLS: security_invoker=true 라 contacts RLS 가 그대로 적용 → 조직 밖 데이터는 못 봄.
-- =============================================

DROP VIEW IF EXISTS mailcaster.contacts_common CASCADE;

CREATE VIEW mailcaster.contacts_common
WITH (security_invoker = true) AS
WITH dedup AS (
  SELECT
    c.org_id,
    LOWER(c.email)                                       AS email_key,
    MIN(c.email)                                         AS email,

    -- 대표 이름/회사/직책 = 가장 먼저 등록된 non-null
    (ARRAY_AGG(c.name       ORDER BY c.created_at) FILTER (WHERE c.name       IS NOT NULL))[1] AS name,
    (ARRAY_AGG(c.company    ORDER BY c.created_at) FILTER (WHERE c.company    IS NOT NULL))[1] AS company,
    (ARRAY_AGG(c.department ORDER BY c.created_at) FILTER (WHERE c.department IS NOT NULL))[1] AS department,
    (ARRAY_AGG(c.job_title  ORDER BY c.created_at) FILTER (WHERE c.job_title  IS NOT NULL))[1] AS job_title,

    -- 상태 플래그는 OR (한 명이라도 unsubscribed 이면 공통에서도 unsubscribed 로 간주)
    BOOL_OR(c.is_unsubscribed)                           AS is_unsubscribed,
    BOOL_OR(c.is_bounced)                                AS is_bounced,

    MIN(c.created_at)                                    AS first_created_at,
    MAX(c.updated_at)                                    AS last_updated_at,
    COUNT(*)                                             AS duplicate_count,

    -- 모든 오너 + 모든 원본 contact id
    JSONB_AGG(
      DISTINCT JSONB_BUILD_OBJECT(
        'contact_id', c.id,
        'user_id',    c.user_id,
        'owner_name', p.display_name,
        'owner_email', p.email
      )
    )                                                    AS owners,

    ARRAY_AGG(DISTINCT c.id)                             AS contact_ids
  FROM mailcaster.contacts c
  LEFT JOIN mailcaster.profiles p ON p.id = c.user_id
  GROUP BY c.org_id, LOWER(c.email)
)
SELECT
  d.*,
  -- 전체 소유자의 그룹 합집합 — correlated subquery 가 d.contact_ids 참조
  COALESCE(
    (
      SELECT JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
        'group_id',       g.id,
        'group_name',     g.name,
        'category_name',  gc.name,
        'category_color', gc.color
      ))
      FROM mailcaster.contact_groups cg
      JOIN mailcaster.groups g              ON g.id = cg.group_id
      LEFT JOIN mailcaster.group_categories gc ON gc.id = g.category_id
      WHERE cg.contact_id = ANY(d.contact_ids)
    ),
    '[]'::jsonb
  ) AS groups
FROM dedup d;

GRANT SELECT ON mailcaster.contacts_common TO anon, authenticated, service_role;

-- =============================================
-- 참고: 템플릿에 대한 "공통" 뷰는 만들지 않음
-- ---------------------------------------------
-- 템플릿은 name + body 가 다른 문서 단위라 중복 병합이 부자연스럽다.
-- 대신 기존 templates 테이블을 조직 전체가 볼 수 있고,
-- 프런트엔드에서 "내 것만 / 전체" 필터 + 오너 표시만 제공하면 충분.
-- =============================================
