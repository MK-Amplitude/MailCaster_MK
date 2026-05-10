// 관계 관리 인사이트 탐지.
//
// 이 도구의 도메인: 오프라인 영업의 보조 채널.
// 메일 마케팅 최적화 (오픈율 클릭률 A/B) 가 목적이 아니라:
//   - 핵심 관계 cadence 유지 (정기 터치 빈도)
//   - 어떤 콘텐츠가 호응을 받았는지 파악 → 다른 사람에게 유사 발송 / 재발송 판단
//
// 따라서 인사이트는 두 카테고리:
//   1) People — 관계 cadence 위주 (지금 누구를 터치할지)
//   2) Campaigns — 호응 위주 (이 발송을 어떻게 후속 활용할지)
//
// 모든 인사이트의 detection 조건은 filter 적용 결과와 정확히 일치해야 한다.

import type {
  ContactEngagementRow,
  EngagementTier,
  CampaignEngagementRow,
} from '@/types/engagement'
import type { CustomerType } from '@/types/contact'
import {
  computeTier,
  isDueSoon,
  isOverdue,
  TOUCH_CADENCE_DAYS,
} from '@/types/engagement'

export type InsightSeverity = 'info' | 'warning' | 'critical' | 'positive'

export type InsightTarget = 'people' | 'campaigns'

// 사람별 탭 필터 — 인사이트/차트 클릭으로 적용 가능한 모든 필드.
export interface PeopleFilter {
  customerType?: CustomerType | 'all'
  customerTypes?: CustomerType[]   // 다중 (입력되면 customerType 무시)
  parentGroup?: string | 'all' | '__none__'
  tier?: EngagementTier | 'all'
  tiers?: EngagementTier[]         // 다중 (입력되면 tier 무시)
  noReply?: boolean                // 발송 ≥1 && reply_count == 0
  hasReply?: boolean               // reply_count > 0
  dueForTouch?: boolean            // cadence 임박 또는 초과
  overdueOnly?: boolean            // cadence 초과만 (더 강한 신호)
}

export interface CampaignFilter {
  lowEngagement?: boolean   // open_rate < LOW_OPEN AND reply_count == 0
  highEngagement?: boolean  // open_rate >= HIGH_OPEN OR reply_rate >= HIGH_REPLY
  noReply?: boolean         // sent_count > 0 && reply_count == 0
  highBounce?: boolean      // bounce_count / sent_count >= HIGH_BOUNCE_RATIO
  recentlySent?: boolean    // last_sent_at within RECENT_DAYS
}

export interface Insight {
  id: string
  target: InsightTarget
  severity: InsightSeverity
  count: number
  label: string
  hint?: string
  peopleFilter?: PeopleFilter
  campaignFilter?: CampaignFilter
}

const MS_PER_DAY = 86400_000
export const LOW_OPEN_RATE = 15        // %
export const HIGH_OPEN_RATE = 50       // %
export const HIGH_REPLY_RATE = 10      // %
export const HIGH_BOUNCE_RATIO = 0.05  // 5%
export const RECENT_DAYS = 7

// 핵심 분류 — cadence 가 정의된, 관계 유지가 중요한 분류
const CORE_CUSTOMER_TYPES: CustomerType[] = [
  'amplitude_customer',
  'partner',
  'relationship',
]

// 분류 한국어 라벨 (간이 — types/contact 의 OPTIONS 와 동기화 권장)
const TYPE_LABEL: Record<CustomerType, string> = {
  amplitude_customer: 'Amplitude 고객',
  prospect: '영업 대상',
  partner: '파트너',
  vendor: '협력 벤더',
  relationship: '관계유지',
  general: '일반',
}

function sentWithin(row: ContactEngagementRow, days: number): boolean {
  if (!row.last_sent_at) return false
  return Date.now() - new Date(row.last_sent_at).getTime() <= days * MS_PER_DAY
}

function campaignSentWithin(c: CampaignEngagementRow, days: number): boolean {
  if (!c.last_sent_at) return false
  return Date.now() - new Date(c.last_sent_at).getTime() <= days * MS_PER_DAY
}

// ─────────────────────────────────────────────────────────────────────────────
// People 인사이트 — 관계 cadence 우선
// ─────────────────────────────────────────────────────────────────────────────

function detectPeopleInsights(rows: ContactEngagementRow[]): Insight[] {
  const insights: Insight[] = []
  const active = rows.filter((r) => !r.is_unsubscribed && !r.is_bounced)

  // 1) [CRITICAL] cadence 초과 핵심 고객/파트너 — 즉시 터치 권장
  // 미터치 핵심 분류 + cadence 넘긴 핵심 분류 (overdue) 합산.
  const overdueCore = active.filter((r) => {
    const ct = (r.customer_type ?? 'general') as CustomerType
    if (!CORE_CUSTOMER_TYPES.includes(ct)) return false
    return isOverdue(ct, r.last_sent_at)
  })
  if (overdueCore.length >= 1) {
    insights.push({
      id: 'overdue-core',
      target: 'people',
      severity: 'critical',
      count: overdueCore.length,
      label: '터치 주기 초과한 핵심 관계',
      hint: '90~180일+ 미터치 — 즉시 안부/근황 메일 권장',
      peopleFilter: {
        customerTypes: CORE_CUSTOMER_TYPES,
        overdueOnly: true,
      },
    })
  }

  // 2) [WARNING] cadence 임박 (60~89일 등) — 예방적 터치
  const dueSoonCore = active.filter((r) => {
    const ct = (r.customer_type ?? 'general') as CustomerType
    if (!CORE_CUSTOMER_TYPES.includes(ct)) return false
    return isDueSoon(ct, r.last_sent_at)
  })
  if (dueSoonCore.length >= 1) {
    insights.push({
      id: 'due-soon-core',
      target: 'people',
      severity: 'warning',
      count: dueSoonCore.length,
      label: '곧 터치 주기 도래 (예방)',
      hint: '핵심 관계 — 한 달 안에 자연스러운 터치',
      peopleFilter: {
        customerTypes: CORE_CUSTOMER_TYPES,
        dueForTouch: true,
      },
    })
  }

  // 3) 분류별 미터치 핵심 — Amplitude 고객 / 파트너 / 관계유지 각각
  for (const ct of CORE_CUSTOMER_TYPES) {
    const neverInType = active.filter(
      (r) => (r.customer_type ?? 'general') === ct && !r.last_sent_at
    )
    if (neverInType.length >= 1) {
      insights.push({
        id: `never-${ct}`,
        target: 'people',
        severity: 'critical',
        count: neverInType.length,
        label: `한 번도 메일 안 보낸 ${TYPE_LABEL[ct]}`,
        hint: '첫 인사 메일 후보',
        peopleFilter: { customerType: ct, tier: 'never' },
      })
    }
  }

  // 4) 분기 커버리지 부족 — 핵심 분류별로 90일 이내 터치 비율이 60% 미만이면 경고
  for (const ct of CORE_CUSTOMER_TYPES) {
    const inType = active.filter((r) => (r.customer_type ?? 'general') === ct)
    if (inType.length < 5) continue // 표본 너무 작으면 의미 없음
    const fresh = inType.filter((r) => sentWithin(r, 90))
    const ratio = fresh.length / inType.length
    if (ratio < 0.6) {
      const stale = inType.filter((r) => !sentWithin(r, 90))
      insights.push({
        id: `low-coverage-${ct}`,
        target: 'people',
        severity: 'warning',
        count: stale.length,
        label: `${TYPE_LABEL[ct]} 분기 커버리지 부족 (${Math.round(ratio * 100)}%)`,
        hint: '90일 내 터치 못한 핵심 분류 — 일괄 안부 메일 후보',
        peopleFilter: {
          customerType: ct,
          tiers: ['dormant', 'cold', 'never'],
        },
      })
    }
  }

  // 5) 응답 없는 영업대상 — 직접 컨택 후보
  const prospects = active.filter(
    (r) => (r.customer_type ?? 'general') === 'prospect'
  )
  const prospectNoReply = prospects.filter(
    (r) => r.total_sent > 0 && r.reply_count === 0
  )
  if (prospectNoReply.length >= 3) {
    insights.push({
      id: 'prospect-no-reply',
      target: 'people',
      severity: 'warning',
      count: prospectNoReply.length,
      label: '응답 없는 영업대상',
      hint: '직접 컨택 또는 메시지 변경 권장',
      peopleFilter: { customerType: 'prospect', noReply: true },
    })
  }

  // 6) [POSITIVE] '관심' 카테고리로 분류된 답장이 있는 연락처 — 최우선 액션
  // 이 카드는 일반 "답장 온" 보다 강한 신호이므로 별도로 부각.
  const interestedRepliers = active.filter((r) => r.interested_reply_count > 0)
  if (interestedRepliers.length >= 1) {
    insights.push({
      id: 'interested-replies',
      target: 'people',
      severity: 'positive',
      count: interestedRepliers.length,
      label: '관심·미팅 의향 답장',
      hint: '톤 분석상 관심 표현 — 즉시 미팅 제안 권장',
      peopleFilter: { hasReply: true },
    })
  }

  // 7) [POSITIVE] 답장이 온 영업대상 — 팔로업 우선
  const repliedProspects = prospects.filter((r) => r.reply_count > 0)
  if (repliedProspects.length >= 1) {
    insights.push({
      id: 'replied-prospects',
      target: 'people',
      severity: 'positive',
      count: repliedProspects.length,
      label: '답장 온 영업대상',
      hint: '팔로업 우선순위',
      peopleFilter: { customerType: 'prospect', hasReply: true },
    })
  }

  // 7) [POSITIVE] 30일 내 답장 — 관계가 살아 있는 사람
  const recentEngaged = active.filter(
    (r) => sentWithin(r, 30) && r.reply_count > 0
  )
  if (recentEngaged.length >= 1) {
    insights.push({
      id: 'recent-engaged',
      target: 'people',
      severity: 'positive',
      count: recentEngaged.length,
      label: '최근 답장이 온 연락처',
      hint: '관계가 살아 있음 — 추가 컨택 자연스러움',
      peopleFilter: { tiers: ['active'], hasReply: true },
    })
  }

  // 8) 그룹사별 휴면 다수 — 그룹 단위 캠페인 후보
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
      hint: '그룹 단위 안부/소식 메일 권장',
      peopleFilter: {
        parentGroup: topDormantGroup.group,
        tiers: ['dormant', 'cold'],
      },
    })
  }

  return insights
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign 인사이트 — 호응 기반, 후속 활용 판단 자료
// ─────────────────────────────────────────────────────────────────────────────

function detectCampaignInsights(campaigns: CampaignEngagementRow[]): Insight[] {
  const insights: Insight[] = []
  const sent = campaigns.filter((c) => c.sent_count > 0)
  if (sent.length === 0) return insights

  // 1) [POSITIVE] 호응 좋은 발송 — 다른 사람에게도 보내볼 후보
  // 오픈율 50%+ OR 답장률 10%+
  const highEngagement = sent.filter(
    (c) => c.open_rate >= HIGH_OPEN_RATE || c.reply_rate >= HIGH_REPLY_RATE
  )
  if (highEngagement.length >= 1) {
    insights.push({
      id: 'campaign-high-engagement',
      target: 'campaigns',
      severity: 'positive',
      count: highEngagement.length,
      label: '호응 좋았던 발송',
      hint: '비슷한 콘텐츠를 다른 사람에게도 보내볼 후보',
      campaignFilter: { highEngagement: true },
    })
  }

  // 2) [WARNING] 호응 적었던 발송 — 내용 변경 후 재발송 검토
  // 오픈율 LOW_OPEN 미만 AND 답장 0
  const lowEngagement = sent.filter(
    (c) => c.open_rate < LOW_OPEN_RATE && c.reply_count === 0
  )
  if (lowEngagement.length >= 1) {
    insights.push({
      id: 'campaign-low-engagement',
      target: 'campaigns',
      severity: 'warning',
      count: lowEngagement.length,
      label: '호응 적었던 발송',
      hint: '제목·본문 손봐서 재발송 검토',
      campaignFilter: { lowEngagement: true },
    })
  }

  // 3) [INFO] 답장 0인 발송 — 직접 후속 연락 필요
  const noReply = sent.filter((c) => c.reply_count === 0)
  if (noReply.length >= 1) {
    insights.push({
      id: 'campaign-no-reply',
      target: 'campaigns',
      severity: 'info',
      count: noReply.length,
      label: '답장이 한 건도 없는 발송',
      hint: '오픈한 사람에게 직접 컨택 권장',
      campaignFilter: { noReply: true },
    })
  }

  // 4) [CRITICAL] 반송 높은 발송 — 데이터 위생
  const highBounce = sent.filter(
    (c) => c.sent_count > 0 && c.bounce_count / c.sent_count >= HIGH_BOUNCE_RATIO
  )
  if (highBounce.length >= 1) {
    insights.push({
      id: 'campaign-high-bounce',
      target: 'campaigns',
      severity: 'critical',
      count: highBounce.length,
      label: `반송 ${(HIGH_BOUNCE_RATIO * 100).toFixed(0)}%+ 발송`,
      hint: '리스트 정리 / 도메인 평판 점검',
      campaignFilter: { highBounce: true },
    })
  }

  // 5) [INFO] 최근 발송 — 진행 중 활동 확인
  const recent = sent.filter((c) => campaignSentWithin(c, RECENT_DAYS))
  if (recent.length >= 1) {
    insights.push({
      id: 'campaign-recent',
      target: 'campaigns',
      severity: 'info',
      count: recent.length,
      label: `최근 ${RECENT_DAYS}일 발송`,
      hint: '진행 중인 활동 — 반응 모니터링',
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
    if (f.lowEngagement) {
      if (!(c.sent_count > 0 && c.open_rate < LOW_OPEN_RATE && c.reply_count === 0))
        return false
    }
    if (f.highEngagement) {
      if (
        !(
          c.sent_count > 0 &&
          (c.open_rate >= HIGH_OPEN_RATE || c.reply_rate >= HIGH_REPLY_RATE)
        )
      )
        return false
    }
    if (f.noReply && !(c.sent_count > 0 && c.reply_count === 0)) return false
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
    f.lowEngagement ||
      f.highEngagement ||
      f.noReply ||
      f.highBounce ||
      f.recentlySent
  )
}

export function describeCampaignFilter(f: CampaignFilter): string {
  const parts: string[] = []
  if (f.highEngagement) parts.push('호응 좋았던 발송')
  if (f.lowEngagement) parts.push('호응 적었던 발송')
  if (f.noReply) parts.push('답장 0')
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

// 정렬 우선순위: critical > warning > positive > info
const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  positive: 2,
  info: 3,
}

export function sortInsights(insights: Insight[]): Insight[] {
  return [...insights].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity]
    const sb = SEVERITY_ORDER[b.severity]
    if (sa !== sb) return sa - sb
    return b.count - a.count
  })
}

// 미사용 변수 ESLint 회피 — TOUCH_CADENCE_DAYS 는 이 모듈 외부 (PeopleTab) 에서도 사용하지만 import 경로 명시 위해 re-export.
export { TOUCH_CADENCE_DAYS }
