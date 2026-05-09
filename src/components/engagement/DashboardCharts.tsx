// 관계 관리 대시보드 — 차트 그리드.
// 모든 차트는 클릭 시 상위 EngagementPage 의 필터 state 를 변경해 드릴다운.

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
  AreaChart,
  Area,
  CartesianGrid,
  LabelList,
} from 'recharts'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { format } from 'date-fns'
import type { ContactEngagementRow, EngagementTier } from '@/types/engagement'
import type { CampaignEngagementRow } from '@/types/engagement'
import {
  CUSTOMER_TYPE_OPTIONS,
  type CustomerType,
} from '@/types/contact'
import {
  ENGAGEMENT_TIER_OPTIONS,
  computeTier,
} from '@/types/engagement'

// recharts 의 formatter / labelFormatter 시그니처가 number 가 아닌 unknown 을 받아
// 직접 타이핑하면 에러가 남 — 단순 helper 로 묶어 unknown 을 number 로 좁히고 cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtCount: any = (v: unknown) =>
  `${(typeof v === 'number' ? v : Number(v) || 0).toLocaleString()}명`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtSent: any = (v: unknown) =>
  `${(typeof v === 'number' ? v : Number(v) || 0).toLocaleString()}건`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtPercent: any = (v: unknown) =>
  `${typeof v === 'number' ? v : Number(v) || 0}%`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtPercentLabel: any = (v: unknown) =>
  `${typeof v === 'number' ? v : Number(v) || 0}%`

const TIER_COLORS: Record<EngagementTier, string> = {
  active: '#10b981',
  recent: '#3b82f6',
  dormant: '#f59e0b',
  cold: '#f43f5e',
  never: '#94a3b8',
}

const CUSTOMER_TYPE_COLORS: Record<CustomerType, string> = {
  amplitude_customer: '#3b82f6',
  prospect: '#f59e0b',
  partner: '#a855f7',
  vendor: '#14b8a6',
  relationship: '#f43f5e',
  general: '#94a3b8',
}

interface Props {
  rows: ContactEngagementRow[]
  campaigns: CampaignEngagementRow[]
  onTierClick?: (t: EngagementTier) => void
  onCustomerTypeClick?: (t: CustomerType) => void
  onParentGroupClick?: (g: string) => void
  onCampaignClick?: (id: string) => void
}

export function DashboardCharts({
  rows,
  campaigns,
  onTierClick,
  onCustomerTypeClick,
  onParentGroupClick,
  onCampaignClick,
}: Props) {
  // 활성 연락처만 (수신거부/반송 제외)
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

  // 2) 고객 분류 분포
  const customerTypeData = useMemo(() => {
    const acc = new Map<CustomerType, number>()
    for (const r of active) {
      const t = (r.customer_type ?? 'general') as CustomerType
      acc.set(t, (acc.get(t) ?? 0) + 1)
    }
    return CUSTOMER_TYPE_OPTIONS.map((o) => ({
      name: o.label,
      type: o.value,
      value: acc.get(o.value) ?? 0,
    })).filter((d) => d.value > 0)
  }, [active])

  // 3) 그룹사 Top10 (연락처 수)
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

  // 4) 일별 발송 트렌드 (최근 30일, 캠페인 데이터 기반)
  const dailySentData = useMemo(() => {
    const days = 30
    const buckets = new Map<string, number>()
    const now = Date.now()
    // 빈 버킷 초기화
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400_000)
      const key = format(d, 'MM/dd')
      buckets.set(key, 0)
    }
    // 캠페인의 last_sent_at 기준 — 정확하진 않지만 활동 리듬은 보임
    // (per-recipient sent_at 으로 가려면 별도 view 필요)
    for (const c of campaigns) {
      if (!c.last_sent_at) continue
      const t = new Date(c.last_sent_at).getTime()
      if (now - t > days * 86400_000) continue
      const key = format(new Date(t), 'MM/dd')
      if (buckets.has(key)) {
        buckets.set(key, (buckets.get(key) ?? 0) + c.sent_count)
      }
    }
    return Array.from(buckets.entries()).map(([date, sent]) => ({ date, sent }))
  }, [campaigns])

  // 5) 캠페인별 오픈율 Top10
  const campaignOpenData = useMemo(
    () =>
      [...campaigns]
        .filter((c) => c.sent_count > 0)
        .sort((a, b) => b.open_rate - a.open_rate)
        .slice(0, 10)
        .map((c) => ({
          id: c.id,
          name: c.name.length > 20 ? c.name.slice(0, 20) + '…' : c.name,
          fullName: c.name,
          open_rate: c.open_rate,
          sent: c.sent_count,
        })),
    [campaigns]
  )

  // 6) 분류별 답장률
  const replyRateByTypeData = useMemo(() => {
    const sent = new Map<CustomerType, number>()
    const replied = new Map<CustomerType, number>()
    for (const r of active) {
      if (r.total_sent === 0) continue
      const t = (r.customer_type ?? 'general') as CustomerType
      sent.set(t, (sent.get(t) ?? 0) + r.total_sent)
      replied.set(t, (replied.get(t) ?? 0) + r.reply_count)
    }
    return CUSTOMER_TYPE_OPTIONS.map((o) => {
      const s = sent.get(o.value) ?? 0
      const rp = replied.get(o.value) ?? 0
      return {
        type: o.value,
        name: o.label,
        rate: s > 0 ? Math.round((rp / s) * 1000) / 10 : 0,
        sent: s,
      }
    }).filter((d) => d.sent > 0)
  }, [active])

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {/* 1) 참여도 분포 (donut) */}
      <ChartCard title="참여도 분포" subtitle="마지막 발송 시점 기준">
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

      {/* 2) 고객 분류 분포 (donut) */}
      <ChartCard title="고객 분류" subtitle="활성 연락처 N명">
        {customerTypeData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={customerTypeData}
                dataKey="value"
                nameKey="name"
                innerRadius={42}
                outerRadius={70}
                paddingAngle={2}
                onClick={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((e: any) => {
                    const t = e?.type ?? e?.payload?.type
                    if (t) onCustomerTypeClick?.(t as CustomerType)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  }) as any
                }
                cursor={onCustomerTypeClick ? 'pointer' : undefined}
              >
                {customerTypeData.map((d) => (
                  <Cell key={d.type} fill={CUSTOMER_TYPE_COLORS[d.type]} />
                ))}
              </Pie>
              <Tooltip formatter={fmtCount} />
            </PieChart>
          </ResponsiveContainer>
        )}
        <Legend
          items={customerTypeData.map((d) => ({
            label: d.name,
            value: d.value,
            color: CUSTOMER_TYPE_COLORS[d.type],
            onClick: onCustomerTypeClick ? () => onCustomerTypeClick(d.type) : undefined,
          }))}
        />
      </ChartCard>

      {/* 3) 그룹사 Top10 (bar, horizontal) */}
      <ChartCard title="그룹사 Top10" subtitle="연락처 수 기준">
        {parentGroupData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(180, parentGroupData.length * 22)}>
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

      {/* 4) 일별 발송 트렌드 (area, 30일) */}
      <ChartCard title="일별 발송 트렌드" subtitle="최근 30일">
        {dailySentData.every((d) => d.sent === 0) ? (
          <EmptyChart label="최근 30일 발송 없음" />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={dailySentData} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip formatter={fmtSent} />
              <Area
                type="monotone"
                dataKey="sent"
                stroke="#3b82f6"
                fill="#3b82f6"
                fillOpacity={0.2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* 5) 캠페인별 오픈율 Top10 */}
      <ChartCard title="캠페인 오픈율 Top10" subtitle="발송 캠페인 중">
        {campaignOpenData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(180, campaignOpenData.length * 22)}>
            <BarChart
              data={campaignOpenData}
              layout="vertical"
              margin={{ top: 4, right: 36, bottom: 4, left: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
              <XAxis type="number" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
              <Tooltip
                formatter={fmtPercent}
                labelFormatter={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((_label: unknown, payload: any) =>
                    payload?.[0]?.payload?.fullName ?? '') as any
                }
              />
              <Bar
                dataKey="open_rate"
                fill="#10b981"
                cursor={onCampaignClick ? 'pointer' : undefined}
                onClick={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((e: any) => {
                    const id = e?.id ?? e?.payload?.id
                    if (id) onCampaignClick?.(id as string)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  }) as any
                }
              >
                <LabelList
                  dataKey="open_rate"
                  position="right"
                  fontSize={10}
                  formatter={fmtPercentLabel}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* 6) 분류별 답장률 */}
      <ChartCard title="분류별 답장률" subtitle="발송 대비 답장 %">
        {replyRateByTypeData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(180, replyRateByTypeData.length * 30)}>
            <BarChart
              data={replyRateByTypeData}
              layout="vertical"
              margin={{ top: 4, right: 36, bottom: 4, left: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
              <XAxis type="number" tick={{ fontSize: 11 }} unit="%" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
              <Tooltip formatter={fmtPercent} />
              <Bar
                dataKey="rate"
                fill="#f43f5e"
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
                  dataKey="rate"
                  position="right"
                  fontSize={10}
                  formatter={fmtPercentLabel}
                />
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
