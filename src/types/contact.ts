import type { Database } from './database.types'

export type Contact = Database['mailcaster']['Tables']['contacts']['Row']
export type ContactInsert = Database['mailcaster']['Tables']['contacts']['Insert']
export type ContactUpdate = Database['mailcaster']['Tables']['contacts']['Update']

type ContactView = Database['mailcaster']['Views']['contact_with_groups']['Row']

export interface ContactWithGroups extends Omit<ContactView, 'groups'> {
  groups: ContactGroupInfo[]
}

export interface ContactGroupInfo {
  group_id: string
  group_name: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
}

export type ContactStatus =
  | 'all'
  | 'normal'
  | 'unsubscribed'
  | 'bounced'
  | 'no_group'
  | 'needs_verification' // company_lookup_status ∈ {pending, failed, not_found}
  | 'archived' // archived_at IS NOT NULL — 1년+ 비활성 (수동 또는 cron 보관)

// Phase 9: 고객 분류 (Phase 9.2 — 6 buckets)
//   amplitude_customer = Amplitude 기존 고객
//   prospect           = 영업 대상 고객
//   partner            = 파트너 (제휴/리셀러)
//   vendor             = 협력 벤더 (서비스/제품 공급사)
//   relationship       = 관계유지 파트너 (장기 네트워크)
//   general            = 일반 (분류 미지정 기본값)
export type CustomerType =
  | 'amplitude_customer'
  | 'prospect'
  | 'partner'
  | 'vendor'
  | 'relationship'
  | 'general'

export const CUSTOMER_TYPE_OPTIONS: Array<{
  value: CustomerType
  label: string
  /** Tailwind 색상 토큰 — Badge / Select 에서 공유 */
  className: string
}> = [
  {
    value: 'amplitude_customer',
    label: 'Amplitude 고객',
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  },
  {
    value: 'prospect',
    label: '영업 대상',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  },
  {
    value: 'partner',
    label: '파트너',
    className:
      'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  },
  {
    value: 'vendor',
    label: '협력 벤더',
    className:
      'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300 border-teal-200 dark:border-teal-800',
  },
  {
    value: 'relationship',
    label: '관계유지',
    className:
      'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  },
  {
    value: 'general',
    label: '일반',
    className: 'bg-muted text-muted-foreground border-border',
  },
]

export function customerTypeLabel(type: CustomerType | null | undefined): string {
  if (!type) return '일반'
  return CUSTOMER_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? '일반'
}

export interface ContactFilters {
  search?: string
  groupIds?: string[]
  status?: ContactStatus
  customerType?: CustomerType | 'all'
  /** 한국 대기업 그룹사 필터 — 'all' 또는 '__none__' 또는 그룹사명 (예: '롯데') */
  parentGroup?: string | 'all' | '__none__'
}
