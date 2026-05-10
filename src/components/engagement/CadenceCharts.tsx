// 관계 cadence 섹션 차트 (4개) — "지금 누구에게 터치할지" 위주.
//   1) 참여도 분포 (donut)            — 마지막 터치 신선도 한눈에
//   2) 마지막 터치 분포 히스토그램 (bar) — fine-grained 6 버킷
//   3) 분류별 90일 커버리지 (stacked bar) — 분기 단위 케어 정도
//   4) 그룹사 Top10 (horizontal bar)  — 어디에 사람이 몰려 있나

import { useMemo } from 'react'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LabelList,
  Legend as RLegend,
} from 'recharts'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  computeTier,
  computeTouchBucket,
  TOUCH_BUCKETS,
  ENGAGEMENT_TIER_OPTIONS,
  type EngagementTier,
  type ContactEngagementRow,
  type TouchBucket,
} from '@/types/engagement'
import {
  CUSTOMER_TYPE_OPTIONS,
  type CustomerType,
} from '@/types/contact'

// recharts 의 formatter 시그니처 회피
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtCount: any = (v: unknown) =>
  `${(typeof v === 'number' ? v : Number(v) || 0).toLocaleString()}명`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtPercent: any = (v: unknown) =>
  `${typeof v === 'number' ? v : Number(v) || 0}%`

const TIER_COLORS: Record<EngagementTier, string> = {
  active: '#10b981',
  recent: '#3b82f6',
  dormant: '#f59e0b',
  cold: '#f43f5e',
  never: '#94a3b8',
}

interface Props {
  rows: ContactEngagementRow[]
  onTierClick?: (t: EngagementTier) => void
  onTouchBucketClick?: (b: TouchBucket) => void
  onParentGroupClick?: (g: string) => void
  onCustomerTypeClick?: (t: CustomerType) => void
}

export function CadenceCharts({
  rows,
  onTierClick,
  onTouchBucketClick,
  onParentGroupClick,
  onCustomerTypeClick,
}: Props) {
  const active = useMemo(
    () => rows.filter((r) => !r.is_unsubscribed && !r.is_bounced),
    [rows]
  )

  // 1) 참여도 분포
  const tierData = useMemo(() => {
    const acc: Record<EngagementTier, number> = {
      active: 0,
      recent: 0,
      dormant: 0,
      cold: 0,
      never: 0,
    }
    for (const r of active) acc[computeTier(r.last_sent_at)]++
    return ENGAGEMENT_TIER_OPTIONS.map((o) => ({
      name: o.label,
      tier: o.value,
      value: acc[o.value],
    })).filter((d) => d.value > 0)
  }, [active])

  // 2) 마지막 터치 분포 (fine-grained)
  const touchBucketData = useMemo(() => {
    const acc: Record<TouchBucket, number> = {
      d0_30: 0,
      d30_60: 0,
      d60_90: 0,
      d90_180: 0,
      d180_plus: 0,
      never: 0,
    }
    for (const r of active) acc[computeTouchBucket(r.last_sent_at)]++
    return TOUCH_BUCKETS.map((b) => ({
      bucket: b.value,
      label: b.label,
      count: acc[b.value],
      color: b.color,
    }))
  }, [active])

  // 3) 분류별 90일 커버리지
  const coverageData = useMemo(() => {
    return CUSTOMER_TYPE_OPTIONS.map((o) => {
      const inType = active.filter((r) => (r.customer_type ?? 'general') === o.value)
      if (inType.length === 0) return null
      const fresh = inType.filter((r) => {
        if (!r.last_sent_at) return false
        return Date.now() - new Date(r.last_sent_at).getTime() <= 90 * 86400_000
      })
      return {
        type: o.value,
        name: o.label,
        총: inType.length,
        '90일 내 터치': fresh.length,
        '90일+ 또는 미터치': inType.length - fresh.length,
        coverage: Math.round((fresh.length / inType.length) * 1000) / 10,
      }
    }).filter((d): d is NonNullable<typeof d> => d !== null)
  }, [active])

  // 4) 그룹사 Top10
  const parentGroupData = useMemo(() => {
    const acc = new Map<string, number>()
    for (const r of active) {
      if (!r.parent_group) continue
      acc.set(r.parent_group, (acc.get(r.parent_group) ?? 0) + 1)
    }
    return Array.from(acc.entries())
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [active])

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      {/* 1) 참여도 분포 */}
      <ChartCard title="참여도 분포" subtitle="마지막 터치 시점 기준">
        {tierData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={tierData}
                dataKey="value"
                nameKey="name"
                innerRadius={42}
                outerRadius={70}
                paddingAngle={2}
                onClick={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((e: any) => {
                    const tier = e?.tier ?? e?.payload?.tier
                    if (tier) onTierClick?.(tier as EngagementTier)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  }) as any
                }
                cursor={onTierClick ? 'pointer' : undefined}
              >
                {tierData.map((d) => (
                  <Cell key={d.tier} fill={TIER_COLORS[d.tier]} />
                ))}
              </Pie>
              <Tooltip formatter={fmtCount} />
            </PieChart>
          </ResponsiveContainer>
        )}
        <Legend
          items={tierData.map((d) => ({
            label: d.name,
            value: d.value,
            color: TIER_COLORS[d.tier],
            onClick: onTierClick ? () => onTierClick(d.tier) : undefined,
          }))}
        />
      </ChartCard>

      {/* 2) 마지막 터치 분포 (fine-grained) */}
      <ChartCard title="마지막 터치 분포" subtitle="6 버킷 — 클릭 시 좁힘">
        {active.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart
              data={touchBucketData}
              margin={{ top: 8, right: 8, bottom: 4, left: -16 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={0} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip formatter={fmtCount} />
              <Bar
                dataKey="count"
                cursor={onTouchBucketClick ? 'pointer' : undefined}
                onClick={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((e: any) => {
                    const b = e?.bucket ?? e?.payload?.bucket
                    if (b) onTouchBucketClick?.(b as TouchBucket)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  }) as any
                }
              >
                {touchBucketData.map((d) => (
                  <Cell key={d.bucket} fill={d.color} />
                ))}
                <LabelList dataKey="count" position="top" fontSize={10} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* 3) 분류별 90일 커버리지 */}
      <ChartCard title="분류별 90일 커버리지" subtitle="최근 90일 내 터치 비율">
        {coverageData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer
            width="100%"
            height={Math.max(180, coverageData.length * 28)}
          >
            <BarChart
              data={coverageData}
              layout="vertical"
              margin={{ top: 4, right: 36, bottom: 4, left: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
              <Tooltip formatter={fmtCount} />
              <RLegend
                wrapperStyle={{ fontSize: 10 }}
                iconType="rect"
                iconSize={8}
              />
              <Bar
                dataKey="90일 내 터치"
                stackId="a"
                fill="#10b981"
                cursor={onCustomerTypeClick ? 'pointer' : undefined}
                onClick={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((e: any) => {
                    const t = e?.type ?? e?.payload?.type
                    if (t) onCustomerTypeClick?.(t as CustomerType)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  }) as any
                }
              />
              <Bar
                dataKey="90일+ 또는 미터치"
                stackId="a"
                fill="#f59e0b"
                cursor={onCustomerTypeClick ? 'pointer' : undefined}
                onClick={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((e: any) => {
                    const t = e?.type ?? e?.payload?.type
                    if (t) onCustomerTypeClick?.(t as CustomerType)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  }) as any
                }
              >
                <LabelList
                  dataKey="coverage"
                  position="right"
                  fontSize={10}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={fmtPercent as any}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* 4) 그룹사 Top10 */}
      <ChartCard title="그룹사 Top10" subtitle="연락처 수 기준">
        {parentGroupData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer
            width="100%"
            height={Math.max(180, parentGroupData.length * 22)}
          >
            <BarChart
              data={parentGroupData}
              layout="vertical"
              margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="group"
                tick={{ fontSize: 11 }}
                width={70}
              />
              <Tooltip formatter={fmtCount} />
              <Bar
                dataKey="count"
                fill="#8b5cf6"
                cursor={onParentGroupClick ? 'pointer' : undefined}
                onClick={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((e: any) => {
                    const g = e?.group ?? e?.payload?.group
                    if (g) onParentGroupClick?.(g as string)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  }) as any
                }
              >
                <LabelList dataKey="count" position="right" fontSize={10} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  )
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && (
            <span className="text-[11px] text-muted-foreground">{subtitle}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-2 pt-0">{children}</CardContent>
    </Card>
  )
}

function Legend({
  items,
}: {
  items: Array<{
    label: string
    value: number
    color: string
    onClick?: () => void
  }>
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 px-2 pb-2 text-[11px]">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          onClick={it.onClick}
          disabled={!it.onClick}
          className={
            'inline-flex items-center gap-1.5 ' +
            (it.onClick ? 'hover:underline cursor-pointer' : 'cursor-default')
          }
        >
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ background: it.color }}
          />
          <span className="text-muted-foreground">{it.label}</span>
          <span className="font-medium tabular-nums">{it.value}</span>
        </button>
      ))}
    </div>
  )
}

function EmptyChart({ label = '데이터 없음' }: { label?: string }) {
  return (
    <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">
      {label}
    </div>
  )
}
