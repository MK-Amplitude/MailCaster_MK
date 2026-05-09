// 관계 관리 — 3-tier 통합 대시보드.
//   Top   : 차트 그리드 (참여도/분류/그룹사/발송 트렌드/캠페인 오픈율/답장률)
//   Mid   : 인사이트 카드 (자동 탐지된 액션 후보)
//   Bottom: 탭 (사람별 / 캠페인별)
// 차트·인사이트 클릭은 PeopleTab 의 필터 state 를 변경해 드릴다운.

import { useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Heart, Users, TrendingUp, Clock, Mail, BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useContactEngagement } from '@/hooks/useContactEngagement'
import { useCampaignEngagement } from '@/hooks/useCampaignEngagement'
import { computeTier, type EngagementTier } from '@/types/engagement'
import { type CustomerType } from '@/types/contact'
import { detectInsights } from '@/lib/insights'
import { DashboardCharts } from '@/components/engagement/DashboardCharts'
import { InsightStrip } from '@/components/engagement/InsightStrip'
import { PeopleTab, type PeopleTabExternalFilter } from '@/components/engagement/PeopleTab'
import { CampaignTab } from '@/components/engagement/CampaignTab'

export default function EngagementPage() {
  const { data: rows = [] } = useContactEngagement()
  const { data: campaigns = [] } = useCampaignEngagement()

  const [tab, setTab] = useState<'people' | 'campaigns'>('people')
  // 외부 필터 — 차트/인사이트 클릭 시 한번 push, PeopleTab 이 적용 후 자체 state 로 보유.
  // counter 로 같은 값 재푸시도 useEffect 트리거.
  const [externalFilter, setExternalFilter] = useState<
    (PeopleTabExternalFilter & { _v: number }) | undefined
  >()
  const [highlightCampaignId, setHighlightCampaignId] = useState<string | null>(null)

  const insights = useMemo(() => detectInsights(rows), [rows])

  const stats = useMemo(() => {
    const acc = { total: 0, active: 0, dormant: 0, never: 0 }
    for (const r of rows) {
      if (r.is_unsubscribed || r.is_bounced) continue
      acc.total++
      const t = computeTier(r.last_sent_at)
      if (t === 'active') acc.active++
      if (t === 'dormant' || t === 'cold') acc.dormant++
      if (t === 'never') acc.never++
    }
    return acc
  }, [rows])

  const pushFilter = (f: PeopleTabExternalFilter) => {
    setTab('people')
    setExternalFilter({ ...f, _v: Date.now() })
  }

  return (
    <div className="flex flex-col h-full">
      {/* 헤더 + KPI */}
      <div className="px-4 sm:px-6 py-4 border-b">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Heart className="w-5 h-5 text-rose-500" />
              관계 관리
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              차트로 한눈에, 인사이트로 액션, 사람·캠페인 단위로 깊이 보기
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <KpiCard icon={Users} label="총 연락처" value={stats.total} accent="text-foreground" />
          <KpiCard icon={TrendingUp} label="활성 (30일)" value={stats.active} accent="text-emerald-600 dark:text-emerald-400" />
          <KpiCard icon={Clock} label="뜸함 (90일+)" value={stats.dormant} accent="text-amber-600 dark:text-amber-400" />
          <KpiCard icon={Mail} label="미발송" value={stats.never} accent="text-muted-foreground" />
        </div>
      </div>

      {/* 본문 — 차트 / 인사이트 / 탭 */}
      <div className="flex-1 overflow-auto">
        <div className="px-4 sm:px-6 py-4 space-y-4 border-b">
          {/* Tier 1 — 차트 */}
          <SectionHeader icon={BarChart3} title="대시보드" subtitle="모든 차트 클릭으로 드릴다운" />
          <DashboardCharts
            rows={rows}
            campaigns={campaigns}
            onTierClick={(t: EngagementTier) => pushFilter({ tier: t })}
            onCustomerTypeClick={(t: CustomerType) => pushFilter({ customerType: t })}
            onParentGroupClick={(g) => pushFilter({ parentGroup: g })}
            onCampaignClick={(id) => {
              setTab('campaigns')
              setHighlightCampaignId(id)
            }}
          />

          {/* Tier 2 — 인사이트 */}
          {insights.length > 0 && (
            <>
              <SectionHeader title="추천 액션" subtitle="자동 탐지된 패턴 — 클릭 시 해당 조건으로 좁힘" />
              <InsightStrip
                insights={insights}
                onClick={(i) =>
                  pushFilter({
                    customerType: i.filter.customerType,
                    parentGroup: i.filter.parentGroup,
                    tier: i.filter.tier,
                    noReply: i.filter.noReply,
                  })
                }
              />
            </>
          )}
        </div>

        {/* Tier 3 — 탭 */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'people' | 'campaigns')} className="flex flex-col">
          <div className="px-4 sm:px-6 pt-3">
            <TabsList>
              <TabsTrigger value="people">사람별 ({stats.total.toLocaleString()})</TabsTrigger>
              <TabsTrigger value="campaigns">캠페인별 ({campaigns.filter((c) => c.sent_count > 0).length.toLocaleString()})</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="people" className="m-0">
            <PeopleTab
              externalFilter={externalFilter}
              onClearExternal={() => setExternalFilter(undefined)}
            />
          </TabsContent>
          <TabsContent value="campaigns" className="m-0">
            <CampaignTab highlightCampaignId={highlightCampaignId} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function KpiCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ElementType
  label: string
  value: number
  accent: string
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2">
          <Icon className={cn('w-4 h-4', accent)} />
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <div className={cn('text-2xl font-semibold mt-1 tabular-nums', accent)}>
          {value.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon?: React.ElementType
  title: string
  subtitle?: string
}) {
  return (
    <div className="flex items-baseline gap-2">
      {Icon && <Icon className="w-4 h-4 text-muted-foreground self-center" />}
      <h2 className="text-sm font-semibold">{title}</h2>
      {subtitle && (
        <span className="text-[11px] text-muted-foreground">{subtitle}</span>
      )}
    </div>
  )
}
