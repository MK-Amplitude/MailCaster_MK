// "활동 / 반응" 섹션 차트 (4개) — "어떤 발송이 호응 받았나, 누구에게 통했나"
//   1) 일별 발송 트렌드 (area, 30일)        — 활동 리듬
//   2) 분류별 평균 호응 (bar, 오픈+답장률) — 누구에게 무엇이 통했나
//   3) 호응 좋은 발송 Top10 (bar)         — 재활용 후보
//   4) 발송 결과 분포 (donut)              — 보낸 메일 전체에서 오픈/답장/반송 비중

import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { format } from 'date-fns'
import type {
  CampaignEngagementRow,
  ContactEngagementRow,
} from '@/types/engagement'
import {
  CUSTOMER_TYPE_OPTIONS,
  type CustomerType,
} from '@/types/contact'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtSent: any = (v: unknown) =>
  `${(typeof v === 'number' ? v : Number(v) || 0).toLocaleString()}건`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtPercent: any = (v: unknown) =>
  `${typeof v === 'number' ? v : Number(v) || 0}%`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmtCount: any = (v: unknown) =>
  `${(typeof v === 'number' ? v : Number(v) || 0).toLocaleString()}`

interface Props {
  rows: ContactEngagementRow[]
  campaigns: CampaignEngagementRow[]
  onCampaignClick?: (id: string) => void
  onCustomerTypeClick?: (t: CustomerType) => void
}

export function ReactionCharts({
  rows,
  campaigns,
  onCampaignClick,
  onCustomerTypeClick,
}: Props) {
  const active = useMemo(
    () => rows.filter((r) => !r.is_unsubscribed && !r.is_bounced),
    [rows]
  )

  // 1) 일별 발송 트렌드 (30일, 캠페인의 last_sent_at + sent_count)
  const dailySentData = useMemo(() => {
    const days = 30
    const buckets = new Map<string, number>()
    const now = Date.now()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400_000)
      buckets.set(format(d, 'MM/dd'), 0)
    }
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

  // 2) 분류별 호응 — 오픈율 + 답장률 (분류별 평균, 발송된 사람만)
  const reactionByTypeData = useMemo(() => {
    const sent = new Map<CustomerType, number>()
    const opens = new Map<CustomerType, number>()
    const replies = new Map<CustomerType, number>()
    for (const r of active) {
      if (r.total_sent === 0) continue
      const t = (r.customer_type ?? 'general') as CustomerType
      sent.set(t, (sent.get(t) ?? 0) + r.total_sent)
      opens.set(t, (opens.get(t) ?? 0) + r.total_opens)
      replies.set(t, (replies.get(t) ?? 0) + r.reply_count)
    }
    return CUSTOMER_TYPE_OPTIONS.map((o) => {
      const s = sent.get(o.value) ?? 0
      const op = opens.get(o.value) ?? 0
      const rp = replies.get(o.value) ?? 0
      return {
        type: o.value,
        name: o.label,
        오픈율: s > 0 ? Math.round((op / s) * 1000) / 10 : 0,
        답장률: s > 0 ? Math.round((rp / s) * 1000) / 10 : 0,
        sent: s,
      }
    }).filter((d) => d.sent > 0)
  }, [active])

  // 3) 호응 좋은 발송 Top10 — 오픈율 또는 답장률 기준
  const topEngagementData = useMemo(() => {
    return [...campaigns]
      .filter((c) => c.sent_count > 0)
      .map((c) => ({
        id: c.id,
        name: c.name.length > 20 ? c.name.slice(0, 20) + '…' : c.name,
        fullName: c.name,
        오픈율: c.open_rate,
        답장률: c.reply_rate,
        sent: c.sent_count,
        // 합산 점수: 오픈 1 + 답장 5 (답장이 5배 가중치)
        score: c.open_rate + c.reply_rate * 5,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
  }, [campaigns])

  // 4) 발송 결과 분포 (전체 누적)
  const sendOutcomeData = useMemo(() => {
    let totalSent = 0
    let totalOpen = 0
    let totalReply = 0
    let totalBounce = 0
    for (const c of campaigns) {
      totalSent += c.sent_count
      totalOpen += c.unique_opens
      totalReply += c.reply_count
      totalBounce += c.bounce_count
    }
    if (totalSent === 0) return []
    const noOpen = totalSent - totalOpen
    return [
      { key: 'open', name: '오픈만', value: Math.max(0, totalOpen - totalReply), color: '#3b82f6' },
      { key: 'reply', name: '답장', value: totalReply, color: '#10b981' },
      { key: 'noopen', name: '미오픈', value: noOpen, color: '#94a3b8' },
      { key: 'bounce', name: '반송', value: totalBounce, color: '#f43f5e' },
    ].filter((d) => d.value > 0)
  }, [campaigns])

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      {/* 1) 일별 발송 트렌드 */}
      <ChartCard title="일별 발송 활동" subtitle="최근 30일">
        {dailySentData.every((d) => d.sent === 0) ? (
          <EmptyChart label="최근 30일 발송 없음" />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart
              data={dailySentData}
              margin={{ top: 4, right: 8, bottom: 4, left: -16 }}
            >
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

      {/* 2) 분류별 호응 (오픈율 + 답장률) */}
      <ChartCard title="분류별 호응" subtitle="오픈율 / 답장률">
        {reactionByTypeData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer
            width="100%"
            height={Math.max(180, reactionByTypeData.length * 36)}
          >
            <BarChart
              data={reactionByTypeData}
              layout="vertical"
              margin={{ top: 4, right: 36, bottom: 4, left: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
              <XAxis type="number" tick={{ fontSize: 11 }} unit="%" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
              <Tooltip formatter={fmtPercent} />
              <Bar
                dataKey="오픈율"
                fill="#3b82f6"
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
                dataKey="답장률"
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
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* 3) 호응 좋은 발송 Top10 */}
      <ChartCard title="호응 좋은 발송" subtitle="재활용 후보">
        {topEngagementData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer
            width="100%"
            height={Math.max(180, topEngagementData.length * 24)}
          >
            <BarChart
              data={topEngagementData}
              layout="vertical"
              margin={{ top: 4, right: 36, bottom: 4, left: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
              <XAxis type="number" tick={{ fontSize: 11 }} unit="%" domain={[0, 100]} />
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
                dataKey="오픈율"
                fill="#3b82f6"
                cursor={onCampaignClick ? 'pointer' : undefined}
                onClick={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ((e: any) => {
                    const id = e?.id ?? e?.payload?.id
                    if (id) onCampaignClick?.(id as string)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  }) as any
                }
              />
              <Bar
                dataKey="답장률"
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
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* 4) 발송 결과 분포 (donut) */}
      <ChartCard title="발송 결과 분포" subtitle="전체 누적">
        {sendOutcomeData.length === 0 ? (
          <EmptyChart label="발송 데이터 없음" />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={sendOutcomeData}
                dataKey="value"
                nameKey="name"
                innerRadius={42}
                outerRadius={70}
                paddingAngle={2}
              >
                {sendOutcomeData.map((d) => (
                  <Cell key={d.key} fill={d.color} />
                ))}
              </Pie>
              <Tooltip formatter={fmtCount} />
            </PieChart>
          </ResponsiveContainer>
        )}
        <Legend
          items={sendOutcomeData.map((d) => ({
            label: d.name,
            value: d.value,
            color: d.color,
          }))}
        />
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
  items: Array<{ label: string; value: number; color: string }>
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 px-2 pb-2 text-[11px]">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ background: it.color }}
          />
          <span className="text-muted-foreground">{it.label}</span>
          <span className="font-medium tabular-nums">
            {it.value.toLocaleString()}
          </span>
        </span>
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
