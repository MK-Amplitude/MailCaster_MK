// 관계 관리 대시보드용 — contact_engagement view (migration 024) 의 row 타입.
// recipients 테이블을 contact 별로 GROUP BY 한 집계 결과.

export interface ContactEngagementRow {
  id: string
  org_id: string
  user_id: string
  email: string
  name: string | null
  company: string | null
  company_ko: string | null
  company_en: string | null
  parent_group: string | null
  customer_type: string | null
  department: string | null
  job_title: string | null
  display_title: string | null
  is_unsubscribed: boolean
  is_bounced: boolean
  contact_created_at: string
  // 집계 컬럼
  sent_campaigns: number
  total_sent: number
  total_opens: number
  reply_count: number
  last_sent_at: string | null
  last_opened_at: string | null
  last_replied_at: string | null
  // 마지막 캠페인 요약 (one-row latest, JSONB)
  last_campaign: {
    campaign_id: string
    campaign_name: string
    sent_at: string | null
    opened: boolean
    open_count: number
    replied: boolean
  } | null
}

// 마지막 발송 기준 참여도 단계 — UI 정렬/필터링에 사용.
export type EngagementTier =
  | 'never'        // 한 번도 발송된 적 없음
  | 'active'       // 30일 이내 발송
  | 'recent'       // 30~90일
  | 'dormant'      // 90~180일
  | 'cold'         // 180일+

export const ENGAGEMENT_TIER_OPTIONS: Array<{
  value: EngagementTier
  label: string
  /** 일 단위 — 마지막 발송 시각 기준 X일 이내 */
  maxDays: number | null
  /** Tailwind 색상 토큰 */
  className: string
}> = [
  { value: 'active',  label: '활성 (30일)',     maxDays: 30,  className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-800' },
  { value: 'recent',  label: '최근 (90일)',     maxDays: 90,  className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800' },
  { value: 'dormant', label: '뜸함 (180일)',    maxDays: 180, className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800' },
  { value: 'cold',    label: '오래됨 (180일+)', maxDays: null, className: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border-rose-200 dark:border-rose-800' },
  { value: 'never',   label: '미발송',          maxDays: null, className: 'bg-muted text-muted-foreground border-border' },
]

/** last_sent_at 으로부터 tier 판정 — null 이면 'never' */
export function computeTier(lastSentAt: string | null): EngagementTier {
  if (!lastSentAt) return 'never'
  const days = (Date.now() - new Date(lastSentAt).getTime()) / 86400_000
  if (days <= 30) return 'active'
  if (days <= 90) return 'recent'
  if (days <= 180) return 'dormant'
  return 'cold'
}

export function tierLabel(tier: EngagementTier): string {
  return ENGAGEMENT_TIER_OPTIONS.find((o) => o.value === tier)?.label ?? tier
}
