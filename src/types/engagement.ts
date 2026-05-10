// 관계 관리 대시보드용 — contact_engagement (024) / campaign_engagement (025) 뷰 row 타입.

// migration 025
export interface CampaignEngagementRow {
  id: string
  org_id: string
  user_id: string
  name: string
  subject: string | null
  status: string
  created_at: string
  scheduled_at: string | null
  sent_count: number
  total_opens: number
  unique_opens: number
  reply_count: number
  /** migration 029 — '관심' 카테고리로 분류된 답장 수 */
  interested_reply_count: number
  bounce_count: number
  total_recipients: number
  open_rate: number  // 0~100
  reply_rate: number // 0~100
  first_sent_at: string | null
  last_sent_at: string | null
}

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
  /** migration 029 — '관심' 카테고리로 분류된 답장 수 */
  interested_reply_count: number
  /** migration 032 — 답장 받았지만 내가 답장 안 한 thread 수 (last_message_from_me=false) */
  awaiting_my_response_count?: number
  last_sent_at: string | null
  last_opened_at: string | null
  last_replied_at: string | null
  // 마지막 캠페인 요약 (one-row latest, JSONB) — migration 029 부터 reply_category 포함
  last_campaign: {
    campaign_id: string
    campaign_name: string
    sent_at: string | null
    opened: boolean
    open_count: number
    replied: boolean
    reply_category?: string | null
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

// ─────────────────────────────────────────────────────────────────────────────
// 터치 cadence — 오프라인 영업 보조 채널의 정기 터치 권장 주기 (일)
// 분류별로 다른 주기를 추천: 핵심 고객은 90일, 영업대상은 더 짧게.
// ─────────────────────────────────────────────────────────────────────────────

export const TOUCH_CADENCE_DAYS: Record<string, number> = {
  amplitude_customer: 90,
  partner: 90,
  relationship: 120,
  vendor: 180,
  prospect: 60,
  general: 0, // 권장 주기 없음 (일반 분류)
}

// "due 임박" — 마지막 터치 후 (cadence - 30) ~ cadence 일 사이.
// "overdue" — 마지막 터치 후 cadence 일 초과.
// 미터치는 cadence 가 0 이 아닌 핵심 분류라면 항상 overdue.
const MS_PER_DAY = 86400_000

export function daysSinceLastSent(lastSentAt: string | null): number | null {
  if (!lastSentAt) return null
  return (Date.now() - new Date(lastSentAt).getTime()) / MS_PER_DAY
}

/** 핵심 분류(cadence > 0)이면서 마지막 터치가 cadence-30 ~ cadence 사이 — 곧 cadence 임박 */
export function isDueSoon(
  customerType: string | null | undefined,
  lastSentAt: string | null
): boolean {
  const ct = customerType ?? 'general'
  const cadence = TOUCH_CADENCE_DAYS[ct] ?? 0
  if (cadence === 0) return false
  const days = daysSinceLastSent(lastSentAt)
  if (days === null) return false // 미터치는 isOverdue 로
  return days >= cadence - 30 && days < cadence
}

/** 마지막 터치 후 cadence 초과 — 즉시 터치 권장 */
export function isOverdue(
  customerType: string | null | undefined,
  lastSentAt: string | null
): boolean {
  const ct = customerType ?? 'general'
  const cadence = TOUCH_CADENCE_DAYS[ct] ?? 0
  if (cadence === 0) return false
  const days = daysSinceLastSent(lastSentAt)
  if (days === null) return true // 미터치 핵심 분류 = overdue
  return days >= cadence
}

/** 권장 주기 근처(임박 OR 초과) — 사람별 탭 "지금 터치 권장" 필터 */
export function isDueForTouch(
  customerType: string | null | undefined,
  lastSentAt: string | null
): boolean {
  return isDueSoon(customerType, lastSentAt) || isOverdue(customerType, lastSentAt)
}

// ─────────────────────────────────────────────────────────────────────────────
// 마지막 터치 분포 히스토그램 — 6개 fine-grained 버킷
// ─────────────────────────────────────────────────────────────────────────────

export type TouchBucket = 'd0_30' | 'd30_60' | 'd60_90' | 'd90_180' | 'd180_plus' | 'never'

export const TOUCH_BUCKETS: Array<{
  value: TouchBucket
  label: string
  /** 이 버킷에 들어갈 최소 일수 (포함) */
  minDays: number | null
  /** 이 버킷에 들어갈 최대 일수 (미포함) — null = 무한 */
  maxDays: number | null
  color: string
}> = [
  { value: 'd0_30',     label: '0~30일',   minDays: 0,    maxDays: 30,   color: '#10b981' },
  { value: 'd30_60',    label: '30~60일',  minDays: 30,   maxDays: 60,   color: '#3b82f6' },
  { value: 'd60_90',    label: '60~90일',  minDays: 60,   maxDays: 90,   color: '#8b5cf6' },
  { value: 'd90_180',   label: '90~180일', minDays: 90,   maxDays: 180,  color: '#f59e0b' },
  { value: 'd180_plus', label: '180일+',   minDays: 180,  maxDays: null, color: '#f43f5e' },
  { value: 'never',     label: '미터치',    minDays: null, maxDays: null, color: '#94a3b8' },
]

export function computeTouchBucket(lastSentAt: string | null): TouchBucket {
  const days = daysSinceLastSent(lastSentAt)
  if (days === null) return 'never'
  if (days < 30) return 'd0_30'
  if (days < 60) return 'd30_60'
  if (days < 90) return 'd60_90'
  if (days < 180) return 'd90_180'
  return 'd180_plus'
}
