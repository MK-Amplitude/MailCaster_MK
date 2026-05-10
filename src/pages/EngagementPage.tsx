// 관계 관리 대시보드 — 오프라인 영업의 보조 채널 관점.
// 메일 마케팅 최적화가 아니라 "정기 터치 / 관계 cadence" 가 중심.
//
// 구조:
//   Top   : KPI 카드 4개
//   Mid-1 : "관계 cadence" 차트 4개 — 누구를 언제 터치할지
//   Mid-2 : "발송 활동 / 호응" 차트 4개 — 어떤 메일이 호응 받았는지 (재활용 판단)
//   Mid-3 : 추천 액션 카드 — 자동 탐지된 패턴 (사람별 / 캠페인별 혼합)
//   Bottom: 두 탭 — 사람별 / 캠페인별
// 차트·인사이트 클릭 시 하단 탭의 필터로 자동 드릴다운.

import { useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Heart,
  Users,
  TrendingUp,
  Clock,
  Mail,
  AlertCircle,
  Zap,
  Layers,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useContactEngagement } from '@/hooks/useContactEngagement'
import { useCampaignEngagement } from '@/hooks/useCampaignEngagement'
import {
  computeTier,
  isOverdue,
  isDueSoon,
  type EngagementTier,
  type TouchBucket,
} from '@/types/engagement'
import { type CustomerType } from '@/types/contact'
import { detectInsights, sortInsights, type Insight } from '@/lib/insights'
import { CadenceCharts } from '@/components/engagement/CadenceCharts'
import { ReactionCharts } from '@/components/engagement/ReactionCharts'
import { InsightStrip } from '@/components/engagement/InsightStrip'
import { PeopleTab, type PeopleTabExternalFilter } from '@/components/engagement/PeopleTab'
import {
  CampaignTab,
  type CampaignTabExternalFilter,
} from '@/components/engagement/CampaignTab'

export default function EngagementPage() {
  const { data: rows = [] } = useContactEngagement()
  const { data: campaigns = [] } = useCampaignEngagement()

  const [tab, setTab] = useState<'people' | 'campaigns'>('people')
  const [peopleExternal, setPeopleExternal] = useState<
    (PeopleTabExternalFilter & { _v: number }) | undefined
  >()
  const [campaignExternal, setCampaignExternal] = useState<
    (CampaignTabExternalFilter & { _v: number }) | undefined
  >()
  const [highlightCampaignId, setHighlightCampaignId] = useState<string | null>(null)

  const insights = useMemo(
    () => sortInsights(detectInsights(rows, campaigns)),
    [rows, campaigns]
  )

  // KPI — 오프라인 영업 cadence 관점에 맞춰 재구성
  const stats = useMemo(() => {
    const acc = { total: 0, dueSoon: 0, overdue: 0, freshThisMonth: 0 }
    for (const r of rows) {
      if (r.is_unsubscribed || r.is_bounced) continue
      acc.total++
      const t = computeTier(r.last_sent_at)
      if (t === 'active') acc.freshThisMonth++
      if (isOverdue(r.customer_type, r.last_sent_at)) acc.overdue++
      if (isDueSoon(r.customer_type, r.last_sent_at)) acc.dueSoon++
    }
    return acc
  }, [rows])

  // 차트 클릭 — additive
  const pushPeopleFilter = (f: PeopleTabExternalFilter) => {
    setTab('people')
    setPeopleExternal({ ...f, _v: Date.now() })
  }

  // 인사이트 클릭 — replace + tab routing
  const handleInsightClick = (i: Insight) => {
    if (i.target === 'people' && i.peopleFilter) {
      setTab('people')
      setPeopleExternal({ ...i.peopleFilter, _replace: true, _v: Date.now() })
      setCampaignExternal({ _replace: true, _v: Date.now() })
    } else if (i.target === 'campaigns' && i.campaignFilter) {
      setTab('campaigns')
      setCampaignExternal({ ...i.campaignFilter, _replace: true, _v: Date.now() })
      setPeopleExternal(undefined)
      setHighlightCampaignId(null)
    }
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
              오프라인 영업의 정기 터치 — 관계 cadence 와 메일 호응을 한눈에
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <KpiCard
            icon={Users}
            label="총 연락처"
            value={stats.total}
            accent="text-foreground"
          />
          <KpiCard
            icon={AlertCircle}
            label="주기 초과 (즉시 터치)"
            value={stats.overdue}
            accent="text-rose-600 dark:text-rose-400"
            onClick={() =>
              pushPeopleFilter({ overdueOnly: true })
            }
          />
          <KpiCard
            icon={Clock}
            label="곧 터치 권장"
            value={stats.dueSoon}
            accent="text-amber-600 dark:text-amber-400"
            onClick={() =>
              pushPeopleFilter({ dueForTouch: true })
            }
          />
          <KpiCard
            icon={TrendingUp}
            label="최근 30일 터치"
            value={stats.freshThisMonth}
            accent="text-emerald-600 dark:text-emerald-400"
            onClick={() => pushPeopleFilter({ tier: 'active' })}
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-4 sm:px-6 py-4 space-y-5 border-b">
          {/* 섹션 1 — 관계 cadence */}
          <section className="space-y-3">
            <SectionHeader
              icon={Layers}
              title="관계 cadence"
              subtitle="누구를 언제 터치할지 — 클릭 시 사람별 탭 자동 좁힘"
            />
            <CadenceCharts
              rows={rows}
              onTierClick={(t: EngagementTier) => pushPeopleFilter({ tier: t })}
              onTouchBucketClick={(b: TouchBucket) =>
                pushPeopleFilter({ touchBucket: b })
              }
              onParentGroupClick={(g) => pushPeopleFilter({ parentGroup: g })}
              onCustomerTypeClick={(t: CustomerType) =>
                pushPeopleFilter({ customerType: t })
              }
            />
          </section>

          {/* 섹션 2 — 발송 활동 / 호응 */}
          <section className="space-y-3">
            <SectionHeader
              icon={Mail}
              title="발송 활동 / 호응"
              subtitle="어떤 메일이 호응 받았나 — 재활용·재발송 판단 자료"
            />
            <ReactionCharts
              rows={rows}
              campaigns={campaigns}
              onCustomerTypeClick={(t: CustomerType) =>
                pushPeopleFilter({ customerType: t })
              }
              onCampaignClick={(id) => {
                setTab('campaigns')
                setHighlightCampaignId(id)
              }}
            />
          </section>

          {/* 섹션 3 — 추천 액션 (인사이트) */}
          {insights.length > 0 && (
            <section className="space-y-3">
              <SectionHeader
                icon={Zap}
                title="추천 액션"
                subtitle="자동 탐지된 패턴 — 클릭 시 해당 조건으로 좁힘"
              />
              <InsightStrip insights={insights} onClick={handleInsightClick} />
            </section>
          )}
        </div>

        {/* 탭 — 사람별 / 캠페인별 */}
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as 'people' | 'campaigns')}
          className="flex flex-col"
        >
          <div className="px-4 sm:px-6 pt-3">
            <TabsList>
              <TabsTrigger value="people">
                사람별 ({stats.total.toLocaleString()})
              </TabsTrigger>
              <TabsTrigger value="campaigns">
                발송별 (
                {campaigns
                  .filter((c) => c.sent_count > 0)
                  .length.toLocaleString()}
                )
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="people" className="m-0">
            <PeopleTab
              externalFilter={peopleExternal}
              onClearExternal={() => setPeopleExternal(undefined)}
            />
          </TabsContent>
          <TabsContent value="campaigns" className="m-0">
            <CampaignTab
              highlightCampaignId={highlightCampaignId}
              externalFilter={campaignExternal}
              onClearExternal={() => setCampaignExternal(undefined)}
            />
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
  onClick,
}: {
  icon: React.ElementType
  label: string
  value: number
  accent: string
  onClick?: () => void
}) {
  return (
    <Card
      className={cn(
        'overflow-hidden',
        onClick && 'transition-colors hover:bg-muted/30 cursor-pointer'
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
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
