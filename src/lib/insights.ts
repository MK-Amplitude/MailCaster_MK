// 관계 관리 인사이트 탐지 — engagement row 들을 스캔해 패턴 카드를 생성.
// 모든 인사이트는 "클릭 시 어떤 필터 조건으로 좁힐지" 정보를 함께 반환해
// 대시보드에서 드릴다운으로 연결한다.

import type { ContactEngagementRow, EngagementTier } from '@/types/engagement'
import type { CustomerType } from '@/types/contact'
import { computeTier } from '@/types/engagement'

export type InsightSeverity = 'info' | 'warning' | 'critical' | 'positive'

// 인사이트를 클릭했을 때 페이지가 적용해야 할 필터 — EngagementPage 의 state 에 매핑.
export interface InsightFilter {
  customerType?: CustomerType
  parentGroup?: string | '__none__'
  tier?: EngagementTier
  // 단순 boolean 플래그들 — 추후 확장
  noReply?: boolean
}

export interface Insight {
  id: string
  severity: InsightSeverity
  // 카드 첫 줄: 큰 숫자
  count: number
  // 둘째 줄: 한 줄 설명 (예: "30일간 답장 0인 영업대상")
  label: string
  // 셋째 줄(옵션): 부가 설명
  hint?: string
  // 클릭 시 적용할 필터
  filter: InsightFilter
}

const MS_PER_DAY = 86400_000

// 헬퍼: 마지막 발송 N일 이내에 sent_at 이 있는지
function sentWithin(row: ContactEngagementRow, days: number): boolean {
  if (!row.last_sent_at) return false
  return Date.now() - new Date(row.last_sent_at).getTime() <= days * MS_PER_DAY
}

export function detectInsights(rows: ContactEngagementRow[]): Insight[] {
  const insights: Insight[] = []

  // 활성 연락처만 대상 — 수신거부/반송은 액션 의미 없음
  const active = rows.filter((r) => !r.is_unsubscribed && !r.is_bounced)

  // 1) 영업대상 중 발송 후 답장 0
  const prospects = active.filter((r) => (r.customer_type ?? 'general') === 'prospect')
  const prospectSent = prospects.filter((r) => r.total_sent > 0)
  const prospectNoReply = prospectSent.filter((r) => r.reply_count === 0)
  if (prospectNoReply.length >= 3) {
    insights.push({
      id: 'prospect-no-reply',
      severity: 'warning',
      count: prospectNoReply.length,
      label: '발송했지만 답장 없는 영업대상',
      hint: '재접촉 또는 메시지 변경 필요',
      filter: { customerType: 'prospect', noReply: true },
    })
  }

  // 2) 90일+ 뜸한 Amplitude 고객 (관계 유지 필요)
  const customers = active.filter(
    (r) => (r.customer_type ?? 'general') === 'amplitude_customer'
  )
  const dormantCustomers = customers.filter((r) => {
    const tier = computeTier(r.last_sent_at)
    return tier === 'dormant' || tier === 'cold'
  })
  if (dormantCustomers.length >= 3) {
    insights.push({
      id: 'dormant-customers',
      severity: 'critical',
      count: dormantCustomers.length,
      label: '90일+ 연락 없는 Amplitude 고객',
      hint: 'NPS / 안부 메일 발송 권장',
      filter: { customerType: 'amplitude_customer', tier: 'dormant' },
    })
  }

  // 3) 미발송 연락처
  const neverSent = active.filter((r) => !r.last_sent_at)
  if (neverSent.length >= 5) {
    insights.push({
      id: 'never-sent',
      severity: 'info',
      count: neverSent.length,
      label: '한 번도 메일을 보내지 않은 연락처',
      hint: '첫 인사 메일 후보',
      filter: { tier: 'never' },
    })
  }

  // 4) 좋은 신호: 답장 받은 영업대상
  const repliedProspects = prospects.filter((r) => r.reply_count > 0)
  if (repliedProspects.length >= 1) {
    insights.push({
      id: 'replied-prospects',
      severity: 'positive',
      count: repliedProspects.length,
      label: '답장이 온 영업대상',
      hint: '팔로업 우선순위',
      filter: { customerType: 'prospect' },
    })
  }

  // 5) 그룹사별 휴면 — 가장 큰 그룹 한 곳만 카드로
  const dormantByGroup = new Map<string, number>()
  for (const r of active) {
    if (!r.parent_group) continue
    const tier = computeTier(r.last_sent_at)
    if (tier === 'dormant' || tier === 'cold') {
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
      severity: 'warning',
      count: topDormantGroup.count,
      label: `${topDormantGroup.group} 그룹 휴면 다수`,
      hint: '그룹 단위 캠페인 권장',
      filter: { parentGroup: topDormantGroup.group, tier: 'dormant' },
    })
  }

  // 6) 최근 활성 — 30일 이내 발송 + 답장
  const recentActive = active.filter(
    (r) => sentWithin(r, 30) && r.reply_count > 0
  )
  if (recentActive.length >= 1) {
    insights.push({
      id: 'recent-engaged',
      severity: 'positive',
      count: recentActive.length,
      label: '30일 내 답장이 온 연락처',
      hint: '관계가 살아 있는 사람들',
      filter: { tier: 'active' },
    })
  }

  return insights
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
