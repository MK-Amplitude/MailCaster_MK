// 인사이트 detection ↔ filter 일치 회귀 방지 테스트.
// 카드의 count 가 N 이라면, 같은 filter 를 적용했을 때도 정확히 N 행이 매칭되어야 함.
//
// 과거 발생한 버그:
//   - dormant-customers: detection=dormant∪cold / filter=tier:dormant 만 → cold 누락
//   - replied-prospects: detection=reply_count>0 / filter=customerType만 → 답장 없는 사람 포함
// 위 케이스들이 다시 발생하지 않도록 detection-filter 동등성 시나리오 검증.

import { describe, it, expect } from 'vitest'
import {
  detectInsights,
  applyCampaignFilter,
  isCampaignFilterActive,
  sortInsights,
  type Insight,
  type PeopleFilter,
} from './insights'
import type { ContactEngagementRow, CampaignEngagementRow } from '@/types/engagement'
import { computeTier } from '@/types/engagement'

// ─── helpers ─────────────────────────────────────────────────────────────

const MS_PER_DAY = 86400_000
const daysAgo = (n: number) => new Date(Date.now() - n * MS_PER_DAY).toISOString()

function row(over: Partial<ContactEngagementRow>): ContactEngagementRow {
  return {
    id: crypto.randomUUID(),
    org_id: 'org',
    user_id: 'user',
    email: 't@example.com',
    name: 'name',
    company: null,
    company_ko: null,
    company_en: null,
    parent_group: null,
    customer_type: 'general',
    department: null,
    job_title: null,
    display_title: null,
    is_unsubscribed: false,
    is_bounced: false,
    contact_created_at: daysAgo(365),
    sent_campaigns: 0,
    total_sent: 0,
    total_opens: 0,
    reply_count: 0,
    interested_reply_count: 0,
    last_sent_at: null,
    last_opened_at: null,
    last_replied_at: null,
    last_campaign: null,
    ...over,
  }
}

function campaign(over: Partial<CampaignEngagementRow>): CampaignEngagementRow {
  return {
    id: crypto.randomUUID(),
    org_id: 'org',
    user_id: 'user',
    name: 'c',
    subject: null,
    status: 'sent',
    created_at: daysAgo(10),
    scheduled_at: null,
    sent_count: 100,
    total_opens: 0,
    unique_opens: 0,
    reply_count: 0,
    interested_reply_count: 0,
    bounce_count: 0,
    total_recipients: 100,
    open_rate: 0,
    reply_rate: 0,
    first_sent_at: daysAgo(10),
    last_sent_at: daysAgo(10),
    ...over,
  }
}

/**
 * People insight 의 filter 를 row 에 직접 적용해 카운트 — detection 결과와 일치해야 함.
 * (PeopleTab 의 실제 filter 적용 로직과 동등한 단순 구현)
 */
function applyPeopleFilter(rows: ContactEngagementRow[], f: PeopleFilter): ContactEngagementRow[] {
  return rows.filter((r) => {
    if (r.is_unsubscribed || r.is_bounced) return false
    const ct = r.customer_type ?? 'general'
    if (f.customerTypes && f.customerTypes.length > 0) {
      if (!f.customerTypes.includes(ct as never)) return false
    } else if (f.customerType && f.customerType !== 'all') {
      if (ct !== f.customerType) return false
    }
    if (f.parentGroup && f.parentGroup !== 'all') {
      if (f.parentGroup === '__none__') {
        if (r.parent_group) return false
      } else if (r.parent_group !== f.parentGroup) return false
    }
    const tier = computeTier(r.last_sent_at)
    if (f.tiers && f.tiers.length > 0) {
      if (!f.tiers.includes(tier)) return false
    } else if (f.tier && f.tier !== 'all') {
      if (tier !== f.tier) return false
    }
    if (f.noReply && (r.reply_count > 0 || r.total_sent === 0)) return false
    if (f.hasReply && r.reply_count === 0) return false
    if (f.overdueOnly) {
      const cadence: Record<string, number> = {
        amplitude_customer: 90,
        partner: 90,
        relationship: 120,
        vendor: 180,
        prospect: 60,
        general: 0,
      }
      const c = cadence[ct] ?? 0
      if (c === 0) return false
      const days = r.last_sent_at
        ? (Date.now() - new Date(r.last_sent_at).getTime()) / MS_PER_DAY
        : Infinity
      if (days < c) return false
    }
    return true
  })
}

// ─── tests ─────────────────────────────────────────────────────────────

describe('detectInsights — people insights count == filter applied count', () => {
  it('overdue-core: critical card matches actual overdue rows', () => {
    const rows: ContactEngagementRow[] = [
      row({ customer_type: 'amplitude_customer', last_sent_at: daysAgo(200) }), // overdue (90+)
      row({ customer_type: 'amplitude_customer', last_sent_at: daysAgo(95) }),  // overdue
      row({ customer_type: 'amplitude_customer', last_sent_at: null }),         // overdue (never)
      row({ customer_type: 'amplitude_customer', last_sent_at: daysAgo(30) }),  // not overdue
      row({ customer_type: 'partner', last_sent_at: daysAgo(100) }),            // overdue
      row({ customer_type: 'general', last_sent_at: null }),                    // general — no cadence
    ]
    const insights = detectInsights(rows)
    const overdue = insights.find((i) => i.id === 'overdue-core')
    expect(overdue).toBeDefined()
    if (!overdue || !overdue.peopleFilter) throw new Error('insight missing')
    const matched = applyPeopleFilter(rows, overdue.peopleFilter)
    expect(matched.length).toBe(overdue.count)
  })

  it('interested-replies: counts contacts with interested_reply_count > 0', () => {
    const rows: ContactEngagementRow[] = [
      row({ reply_count: 1, interested_reply_count: 1 }),  // 관심
      row({ reply_count: 1, interested_reply_count: 0 }),  // 답장은 있지만 관심 아님
      row({ reply_count: 0, interested_reply_count: 0 }),  // 답장 없음
      row({ customer_type: 'partner', reply_count: 2, interested_reply_count: 2 }),  // 관심 (다른 분류)
    ]
    const insights = detectInsights(rows)
    const interested = insights.find((i) => i.id === 'interested-replies')
    expect(interested?.count).toBe(2)
    expect(interested?.severity).toBe('positive')
  })

  it('replied-prospects: filter must restrict to reply_count > 0', () => {
    const rows: ContactEngagementRow[] = [
      row({ customer_type: 'prospect', total_sent: 1, reply_count: 1 }),
      row({ customer_type: 'prospect', total_sent: 1, reply_count: 0 }),
      row({ customer_type: 'prospect', total_sent: 1, reply_count: 2 }),
      row({ customer_type: 'amplitude_customer', total_sent: 1, reply_count: 1 }),
    ]
    const insights = detectInsights(rows)
    const replied = insights.find((i) => i.id === 'replied-prospects')
    expect(replied?.count).toBe(2)
    if (!replied?.peopleFilter) throw new Error('insight missing')
    const matched = applyPeopleFilter(rows, replied.peopleFilter)
    expect(matched.length).toBe(replied.count)
  })

  it('never-amplitude_customer: only never + amplitude_customer counted', () => {
    const rows: ContactEngagementRow[] = [
      row({ customer_type: 'amplitude_customer', last_sent_at: null }),
      row({ customer_type: 'amplitude_customer', last_sent_at: null }),
      row({ customer_type: 'amplitude_customer', last_sent_at: daysAgo(10) }),
      row({ customer_type: 'partner', last_sent_at: null }),
    ]
    const insights = detectInsights(rows)
    const neverAmp = insights.find((i) => i.id === 'never-amplitude_customer')
    expect(neverAmp?.count).toBe(2)
    if (!neverAmp?.peopleFilter) throw new Error('insight missing')
    const matched = applyPeopleFilter(rows, neverAmp.peopleFilter)
    expect(matched.length).toBe(neverAmp.count)
  })

  it('excludes unsubscribed/bounced from all insights', () => {
    const rows: ContactEngagementRow[] = [
      row({ customer_type: 'amplitude_customer', last_sent_at: null, is_unsubscribed: true }),
      row({ customer_type: 'amplitude_customer', last_sent_at: null, is_bounced: true }),
      row({ customer_type: 'amplitude_customer', last_sent_at: null }), // active
    ]
    const insights = detectInsights(rows)
    const neverAmp = insights.find((i) => i.id === 'never-amplitude_customer')
    expect(neverAmp?.count).toBe(1)
  })

  it('low-coverage threshold: < 60% triggers, otherwise no card', () => {
    // 10 amplitude — 7 fresh (within 90d), 3 stale → coverage 70% ≥ 60% : no insight
    const fresh = Array.from({ length: 7 }).map(() =>
      row({ customer_type: 'amplitude_customer', last_sent_at: daysAgo(10) })
    )
    const stale = Array.from({ length: 3 }).map(() =>
      row({ customer_type: 'amplitude_customer', last_sent_at: daysAgo(200) })
    )
    let insights = detectInsights([...fresh, ...stale])
    expect(insights.find((i) => i.id === 'low-coverage-amplitude_customer')).toBeUndefined()
    // Now flip — 5 stale → coverage 5/12 ≈ 42% < 60% : insight present
    const stale2 = Array.from({ length: 5 }).map(() =>
      row({ customer_type: 'amplitude_customer', last_sent_at: daysAgo(200) })
    )
    insights = detectInsights([...fresh, ...stale2])
    expect(insights.find((i) => i.id === 'low-coverage-amplitude_customer')).toBeDefined()
  })
})

describe('detectInsights — campaign insights', () => {
  it('high-engagement: open ≥50% OR reply ≥10%', () => {
    const cs: CampaignEngagementRow[] = [
      campaign({ open_rate: 60, reply_rate: 0 }),  // high open
      campaign({ open_rate: 5, reply_rate: 15 }),  // high reply
      campaign({ open_rate: 5, reply_rate: 5 }),   // neither
    ]
    const insights = detectInsights([], cs)
    const high = insights.find((i) => i.id === 'campaign-high-engagement')
    expect(high?.count).toBe(2)
  })

  it('high-engagement filter matches detection', () => {
    const cs: CampaignEngagementRow[] = [
      campaign({ open_rate: 60, reply_rate: 0 }),
      campaign({ open_rate: 5, reply_rate: 15 }),
      campaign({ open_rate: 5, reply_rate: 5 }),
    ]
    const insights = detectInsights([], cs)
    const high = insights.find((i) => i.id === 'campaign-high-engagement')
    if (!high?.campaignFilter) throw new Error('insight missing')
    const matched = applyCampaignFilter(cs, high.campaignFilter)
    expect(matched.length).toBe(high.count)
  })

  it('low-engagement: open <15% AND reply 0', () => {
    const cs: CampaignEngagementRow[] = [
      campaign({ open_rate: 10, reply_count: 0 }),  // low engagement
      campaign({ open_rate: 10, reply_count: 1 }),  // has reply — not low
      campaign({ open_rate: 30, reply_count: 0 }),  // not low (open ≥ 15)
    ]
    const insights = detectInsights([], cs)
    const low = insights.find((i) => i.id === 'campaign-low-engagement')
    expect(low?.count).toBe(1)
  })

  it('high-bounce filter matches detection', () => {
    const cs: CampaignEngagementRow[] = [
      campaign({ sent_count: 100, bounce_count: 10 }), // 10% — high
      campaign({ sent_count: 100, bounce_count: 4 }),  // 4% — not high
    ]
    const insights = detectInsights([], cs)
    const hb = insights.find((i) => i.id === 'campaign-high-bounce')
    if (!hb?.campaignFilter) throw new Error('insight missing')
    const matched = applyCampaignFilter(cs, hb.campaignFilter)
    expect(matched.length).toBe(hb.count)
  })
})

describe('sortInsights — severity then count', () => {
  it('orders critical > warning > positive > info', () => {
    const ins: Insight[] = [
      { id: 'a', target: 'people', severity: 'info', count: 100, label: 'a' },
      { id: 'b', target: 'people', severity: 'critical', count: 1, label: 'b' },
      { id: 'c', target: 'people', severity: 'warning', count: 5, label: 'c' },
      { id: 'd', target: 'people', severity: 'positive', count: 10, label: 'd' },
    ]
    const sorted = sortInsights(ins)
    expect(sorted.map((i) => i.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('breaks ties by count desc', () => {
    const ins: Insight[] = [
      { id: 'small', target: 'people', severity: 'warning', count: 3, label: 'a' },
      { id: 'big', target: 'people', severity: 'warning', count: 100, label: 'b' },
    ]
    expect(sortInsights(ins).map((i) => i.id)).toEqual(['big', 'small'])
  })
})

describe('isCampaignFilterActive', () => {
  it('false for empty filter', () => {
    expect(isCampaignFilterActive({})).toBe(false)
    expect(isCampaignFilterActive(undefined)).toBe(false)
  })
  it('true for any boolean true', () => {
    expect(isCampaignFilterActive({ noReply: true })).toBe(true)
    expect(isCampaignFilterActive({ highBounce: true })).toBe(true)
  })
  it('false when all flags false', () => {
    expect(
      isCampaignFilterActive({
        lowEngagement: false,
        highEngagement: false,
        noReply: false,
        highBounce: false,
        recentlySent: false,
      })
    ).toBe(false)
  })
})
