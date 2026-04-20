// ============================================================
// 조직(Organization) 관련 타입
// ------------------------------------------------------------
// DB 스키마(013_organizations.sql) 에 맞춘 수동 타입.
// `database.types.ts` 가 재생성되면 거기서 re-export 하도록 정리 가능.
// ============================================================

export type OrgRole = 'owner' | 'admin' | 'member'
export type OrgInviteRole = Exclude<OrgRole, 'owner'> // 초대 시 owner 부여 불가

export interface Organization {
  id: string
  name: string
  slug: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface OrgMember {
  org_id: string
  user_id: string
  role: OrgRole
  invited_by: string | null
  joined_at: string
  // 조인된 profiles 정보 (UI 표시용, 서버 응답 시 포함)
  email?: string
  display_name?: string | null
}

export interface OrgInvitation {
  id: string
  org_id: string
  email: string
  role: OrgInviteRole
  invited_by: string | null
  created_at: string
  accepted_at: string | null
}

// ============================================================
// "공통(dedupe)" 뷰 타입 — contacts_common
// ------------------------------------------------------------
// 같은 조직 내 같은 이메일의 여러 오너 연락처를 하나로 합친 뷰.
// ============================================================
export interface ContactOwnerInfo {
  contact_id: string
  user_id: string
  owner_name: string | null
  owner_email: string
}

export interface ContactGroupInfo {
  group_id: string
  group_name: string
  category_name: string | null
  category_color: string | null
}

export interface ContactCommon {
  org_id: string
  email_key: string
  email: string
  name: string | null
  company: string | null
  department: string | null
  job_title: string | null
  is_unsubscribed: boolean
  is_bounced: boolean
  first_created_at: string
  last_updated_at: string
  duplicate_count: number
  owners: ContactOwnerInfo[]
  contact_ids: string[]
  groups: ContactGroupInfo[]
}
