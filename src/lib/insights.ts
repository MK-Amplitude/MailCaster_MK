// 관계 관리 인사이트 탐지 — engagement row 들을 스캔해 패턴 카드를 생성.
// 모든 인사이트는 "클릭 시 어떤 필터 조건으로 좁힐지" 정보를 함께 반환해
// 대시보드에서 드릴다운으로 연결한다.
//
// 중요: detection 의 조건과 filter 의 적용 결과는 반드시 일치해야 함.
// (그래야 "30명" 카드를 누르면 정확히 30명이 나옴)

import type {
  ContactEngagementRow,
  EngagementTier,
  CampaignEngagementRow,
} from '@/types/engagement'
import type { CustomerType } from '@/types/contact'
import { computeTier } from '@/types/engagement'

export type InsightSeverity = 'info' | 'warning' | 'critical' | 'positive'

// 인사이트 카드의 작용 대상 — people 탭 / campaigns 탭
export type InsightTarget = 'people' | 'campaigns'

// 사람별 탭 필터 — 인사이트/차트 클릭으로 적용 가능한 모든 필드.
// undefined = 변경 없음. 'all' / false / [] = 명시적 초기화.
export interface PeopleFilter {
  customerType?: CustomerType | 'all'
  parentGroup?: string | 'all' | '__none__'
  tier?: EngagementTier | 'all'
  tiers?: EngagementTier[]   // 다중 (tiers 가 비어있지 않으면 tier 무시)
  noReply?: boolean          // true: 발송 ≥1 && reply_count == 0
  hasReply?: boolean         // true: reply_count > 0
}

// 캠페인별 탭 필터 — 캠페인 quality 기준 분류
export interface CampaignFilter {
  // boolean 들은 OR 가 아닌 AND. 보통 한 인사이트는 한 가지 조건만 활성.
  lowOpenRate?: boolean      // open_rate < LOW_OPEN_RATE
  highOpenRate?: boolean     // open_rate >= HIGH_OPEN_RATE
  noReply?: boolean          // sent_count > 0 && reply_count == 0
  highReplyRate?: boolean    // reply_rate >= HIGH_REPLY_RATE
  highBounce?: boolean       // bounce_count / sent_count >= HIGH_BOUNCE_RATIO
  recentlySent?: boolean     // last_sent_at within RECENT_DAYS
  // 정렬은 PeopleTab/CampaignTab 자체 sort 그대로
}

export interface Insight {
  id: string
  target: InsightTarget
  severity: InsightSeverity
  count: number
  label: string
  hint?: string
  peopleFilter?: PeopleFilter      // target === 'people'
  campaignFilter?: CampaignFilter  // target === 'campaigns'
}

const MS_PER_DAY = 86400_000
export const LOW_OPEN_RATE = 10        // %
export const HIGH_OPEN_RATE = 50       // %
export const HIGH_REPLY_RATE = 10      // %
export const HIGH_BOUNCE_RATIO = 0.05  // 5%
export const RECENT_DAYS = 7

function sentWithin(row: ContactEngagementRow, days: number): boolean {
  if (!row.last_sent_at) return false
  return Date.now() - new Date(row.last_sent_at).getTime() <= days * MS_PER_DAY
}

function campaignSentWithin(c: CampaignEngagementRow, days: number): boolean {
  if (!c.last_sent_at) return false
  return Date.now() - new Date(c.last_sent_at).getTime() <= days * MS_PER_DAY
}

// ─────────────────────────────────────────────────────────────────────────────
// People 인사이트
// ─────────────────────────────────────────────────────────────────────────────

function detectPeopleInsights(rows: ContactEngagementRow[]): Insight[] {
  const insights: Insight[] = []

  // 활성 연락처만 (수신거부/반송 제외)
  const active = rows.filter((r) => !r.is_unsubscribed && !r.is_bounced)

  // 1) 발송 후 답장 없는 영업대상
  const prospects = active.filter((r) => (r.customer_type ?? 'general') === 'prospect')
  const prospectNoReply = prospects.filter(
    (r) => r.total_sent > 0 && r.reply_count === 0
  )
  if (prospectNoReply.length >= 3) {
    insights.push({
      id: 'prospect-no-reply',
      target: 'people',
      severity: 'warning',
      count: prospectNoReply.length,
      label: '발송했지만 답장 없는 영업대상',
      hint: '재접촉 또는 메시지 변경 필요',
      peopleFilter: { customerType: 'prospect', noReply: true },
    })
  }

  // 2) 90일+ 연락 없는 Amplitude 고객 (dormant ∪ cold)
  const customers = active.filter(
    (r) => (r.customer_type ?? 'general') === 'amplitude_customer'
  )
  const dormantCustomers = customers.filter((r) => {
    const t = computeTier(r.last_sent_at)
    return t === 'dormant' || t === 'cold'
  })
  if (dormantCustomers.length >= 3) {
    insights.push({
      id: 'dormant-customers',
      target: 'people',
      severity: 'critical',
      count: dormantCustomers.length,
      label: '90일+ 연락 없는 Amplitude 고객',
      hint: 'NPS / 안부 메일 발송 권장',
      peopleFilter: {
        customerType: 'amplitude_customer',
        tiers: ['dormant', 'cold'],
      },
    })
  }

  // 3) 미발송 연락처
  const neverSent = active.filter((r) => !r.last_sent_at)
  if (neverSent.length >= 5) {
    insights.push({
      id: 'never-sent',
      target: 'people',
      severity: 'info',
      count: neverSent.length,
      label: '한 번도 메일을 보내지 않은 연락처',
      hint: '첫 인사 메일 후보',
      peopleFilter: { tier: 'never' },
    })
  }

  // 4) 답장이 온 영업대상 (reply_count > 0)
  const repliedProspects = prospects.filter((r) => r.reply_count > 0)
  if (repliedProspects.length >= 1) {
    insights.push({
      id: 'replied-prospects',
      target: 'people',
      severity: 'positive',
      count: repliedProspects.length,
      label: '답장이 온 영업대상',
      hint: '팔로업 우선순위',
      peopleFilter: { customerType: 'prospect', hasReply: true },
    })
  }

  // 5) 그룹사별 휴면 — 가장 큰 그룹 한 곳만
  const dormantByGroup = new Map<string, number>()
  for (const r of active) {
    if (!r.parent_group) continue
    const t = computeTier(r.last_sent_at)
    if (t === 'dormant' || t === 'cold') {
      dormantByGroup.set(r.parent_group, (dormantByGroup.get(r.parent_group) ?? 0) + 1)
    }
  }
  let topDormantGroup: { group: string; count: number } | null = null
  for (const [group, count] of dormantByGroup) {
    if (!topDormantGroup || count > topDormantGroup.count) {
      topDormantGroup = { group, count }
    }
  }
  if (topDormantGroup && topDormantGroup.count >= 3) {
    insights.push({
      id: `dormant-group-${topDormantGroup.group}`,
      target: 'people',
      severity: 'warning',
      count: topDormantGroup.count,
      label: `${topDormantGroup.group} 그룹 휴면 다수`,
      hint: '그룹 단위 캠페인 권장',
      peopleFilter: {
        parentGroup: topDormantGroup.group,
        tiers: ['dormant', 'cold'],
      },
    })
  }

  // 6) 30일 내 답장이 온 연락처
  const recentEngaged = active.filter(
    (r) => sentWithin(r, 30) && r.reply_count > 0
  )
  if (recentEngaged.length >= 1) {
    insights.push({
      id: 'recent-engaged',
      target: 'people',
      severity: 'positive',
      count: recentEngaged.length,
      label: '30일 내 답장이 온 연락처',
      hint: '관계가 살아 있는 사람들',
      peopleFilter: { tiers: ['active'], hasReply: true },
    })
  }

  return insights
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign 인사이트
// ─────────────────────────────────────────────────────────────────────────────

function detectCampaignInsights(campaigns: CampaignEngagementRow[]): Insight[] {
  const insights: Insight[] = []

  // 발송된 캠페인만 의미 있음
  const sent = campaigns.filter((c) => c.sent_count > 0)
  if (sent.length === 0) return insights

  // 1) 오픈율 낮은 캠페인 (10% 미만)
  const lowOpen = sent.filter((c) => c.open_rate < LOW_OPEN_RATE)
  if (lowOpen.length >= 1) {
    insights.push({
      id: 'campaign-low-open',
      target: 'campaigns',
      severity: 'warning',
      count: lowOpen.length,
      label: `오픈율 ${LOW_OPEN_RATE}% 미만 캠페인`,
      hint: '제목 / 발신자 점검',
      campaignFilter: { lowOpenRate: true },
    })
  }

  // 2) 답장 0인 캠페인 (보냈는데 답장 없음)
  const noReply = sent.filter((c) => c.reply_count === 0)
  if (noReply.length >= 1) {
    insights.push({
      id: 'campaign-no-reply',
      target: 'campaigns',
      severity: 'info',
      count: noReply.length,
      label: '답장이 한 건도 없는 캠페인',
      hint: 'CTA / 본문 톤 검토',
      campaignFilter: { noReply: true },
    })
  }

  // 3) 반송율 높은 캠페인
  const highBounce = sent.filter(
    (c) => c.sent_count > 0 && c.bounce_count / c.sent_count >= HIGH_BOUNCE_RATIO
  )
  if (highBounce.length >= 1) {
    insights.push({
      id: 'campaign-high-bounce',
      target: 'campaigns',
      severity: 'critical',
      count: highBounce.length,
      label: `반송 ${(HIGH_BOUNCE_RATIO * 100).toFixed(0)}%+ 캠페인`,
      hint: '리스트 정리 / 도메인 평판 점검',
      campaignFilter: { highBounce: true },
    })
  }

  // 4) 오픈율 높은 캠페인 (반대 신호)
  const highOpen = sent.filter((c) => c.open_rate >= HIGH_OPEN_RATE)
  if (highOpen.length >= 1) {
    insights.push({
      id: 'campaign-high-open',
      target: 'campaigns',
      severity: 'positive',
      count: highOpen.length,
      label: `오픈율 ${HIGH_OPEN_RATE}%+ 인기 캠페인`,
      hint: '제목/발송 시간 패턴 학습',
      campaignFilter: { highOpenRate: true },
    })
  }

  // 5) 답장률 높은 캠페인
  const highReply = sent.filter((c) => c.reply_rate >= HIGH_REPLY_RATE)
  if (highReply.length >= 1) {
    insights.push({
      id: 'campaign-high-reply',
      target: 'campaigns',
      severity: 'positive',
      count: highReply.length,
      label: `답장률 ${HIGH_REPLY_RATE}%+ 효과 캠페인`,
      hint: '본문/CTA 패턴 학습',
      campaignFilter: { highReplyRate: true },
    })
  }

  // 6) 최근 일주일 발송
  const recent = sent.filter((c) => campaignSentWithin(c, RECENT_DAYS))
  if (recent.length >= 1) {
    insights.push({
      id: 'campaign-recent',
      target: 'campaigns',
      severity: 'info',
      count: recent.length,
      label: `최근 ${RECENT_DAYS}일 발송 캠페인`,
      hint: '진행 중인 활동',
      campaignFilter: { recentlySent: true },
    })
  }

  return insights
}

// ─────────────────────────────────────────────────────────────────────────────
// 통합 detector
// ─────────────────────────────────────────────────────────────────────────────

export function detectInsights(
  rows: ContactEngagementRow[],
  campaigns: CampaignEngagementRow[] = []
): Insight[] {
  return [
    ...detectPeopleInsights(rows),
    ...detectCampaignInsights(campaigns),
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 캠페인 필터 적용 헬퍼 — CampaignTab 에서 재사용
// ─────────────────────────────────────────────────────────────────────────────

export function applyCampaignFilter(
  campaigns: CampaignEngagementRow[],
  f: CampaignFilter | undefined
): CampaignEngagementRow[] {
  if (!f) return campaigns
  return campaigns.filter((c) => {
    if (f.lowOpenRate && !(c.sent_count > 0 && c.open_rate < LOW_OPEN_RATE)) return false
    if (f.highOpenRate && !(c.sent_count > 0 && c.open_rate >= HIGH_OPEN_RATE)) return false
    if (f.noReply && !(c.sent_count > 0 && c.reply_count === 0)) return false
    if (f.highReplyRate && !(c.sent_count > 0 && c.reply_rate >= HIGH_REPLY_RATE)) return false
    if (
      f.highBounce &&
      !(c.sent_count > 0 && c.bounce_count / c.sent_count >= HIGH_BOUNCE_RATIO)
    )
      return false
    if (f.recentlySent && !campaignSentWithin(c, RECENT_DAYS)) return false
    return true
  })
}

export function isCampaignFilterActive(f: CampaignFilter | undefined): boolean {
  if (!f) return false
  return Boolean(
    f.lowOpenRate ||
      f.highOpenRate ||
      f.noReply ||
      f.highReplyRate ||
      f.highBounce ||
      f.recentlySent
  )
}

export function describeCampaignFilter(f: CampaignFilter): string {
  const parts: string[] = []
  if (f.lowOpenRate) parts.push(`오픈율 <${LOW_OPEN_RATE}%`)
  if (f.highOpenRate) parts.push(`오픈율 ≥${HIGH_OPEN_RATE}%`)
  if (f.noReply) parts.push('답장 0')
  if (f.highReplyRate) parts.push(`답장률 ≥${HIGH_REPLY_RATE}%`)
  if (f.highBounce) parts.push(`반송 ≥${(HIGH_BOUNCE_RATIO * 100).toFixed(0)}%`)
  if (f.recentlySent) parts.push(`${RECENT_DAYS}일 내`)
  return parts.join(' / ')
}

export const INSIGHT_SEVERITY_STYLES: Record<InsightSeverity, string> = {
  info: 'border-blue-200 bg-blue-50/60 hover:bg-blue-100/60 dark:border-blue-900 dark:bg-blue-950/40 dark:hover:bg-blue-950/60',
  warning:
    'border-amber-200 bg-amber-50/60 hover:bg-amber-100/60 dark:border-amber-900 dark:bg-amber-950/40 dark:hover:bg-amber-950/60',
  critical:
    'border-rose-200 bg-rose-50/60 hover:bg-rose-100/60 dark:border-rose-900 dark:bg-rose-950/40 dark:hover:bg-rose-950/60',
  positive:
    'border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/60 dark:border-emerald-900 dark:bg-emerald-950/40 dark:hover:bg-emerald-950/60',
}

export const INSIGHT_ACCENT_TEXT: Record<InsightSeverity, string> = {
  info: 'text-blue-700 dark:text-blue-300',
  warning: 'text-amber-700 dark:text-amber-300',
  critical: 'text-rose-700 dark:text-rose-300',
  positive: 'text-emerald-700 dark:text-emerald-300',
}
