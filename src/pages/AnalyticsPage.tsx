// 분석 — outbound 퍼널 + 세그먼트별 성과 (Tier 3 고도화).

import { useState } from 'react'
import { BarChart3, Loader2 } from 'lucide-react'
import {
  useOutboundFunnel,
  useSegmentPerformance,
  type SegmentDimension,
} from '@/hooks/useAnalytics'
import { Card } from '@/components/ui/card'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'

const RANGE_OPTIONS = [
  { value: 7, label: '최근 7일' },
  { value: 30, label: '최근 30일' },
  { value: 90, label: '최근 90일' },
]

const DIM_OPTIONS: { value: SegmentDimension; label: string }[] = [
  { value: 'parent_group', label: '그룹사' },
  { value: 'customer_type', label: '고객 유형' },
  { value: 'job_title', label: '직책' },
]

function pct(n: number, d: number): string {
  if (d <= 0) return '—'
  return `${Math.round((n / d) * 1000) / 10}%`
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30)
  const [dim, setDim] = useState<SegmentDimension>('parent_group')
  const { data: funnel, isLoading: funnelLoading } = useOutboundFunnel(days)
  const { data: segments = [], isLoading: segLoading } = useSegmentPerformance(dim, days)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-primary" /> 분석
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            캠페인 + 시퀀스/1:1 발송 성과. 반송 제외.
          </p>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 퍼널 카드 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FunnelCard label="발송" value={funnel?.sent ?? 0} sub={null} loading={funnelLoading} />
        <FunnelCard
          label="오픈"
          value={funnel?.opened ?? 0}
          sub={funnel ? `오픈율 ${pct(funnel.opened, funnel.sent)}` : null}
          loading={funnelLoading}
        />
        <FunnelCard
          label="회신"
          value={funnel?.replied ?? 0}
          sub={funnel ? `회신율 ${pct(funnel.replied, funnel.sent)}` : null}
          loading={funnelLoading}
        />
      </div>

      {/* 세그먼트 성과 */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">세그먼트별 성과</h2>
          <Select value={dim} onValueChange={(v) => setDim(v as SegmentDimension)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DIM_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {segLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : segments.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">집계할 발송 데이터가 없습니다.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{DIM_OPTIONS.find((d) => d.value === dim)?.label}</TableHead>
                <TableHead className="text-right">발송</TableHead>
                <TableHead className="text-right">오픈율</TableHead>
                <TableHead className="text-right">회신율</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((s) => (
                <TableRow key={s.segment}>
                  <TableCell className="font-medium">{s.segment}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{s.sent}</TableCell>
                  <TableCell className="text-right">{pct(s.opened, s.sent)}</TableCell>
                  <TableCell className="text-right font-medium">{pct(s.replied, s.sent)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground mt-3">
          회신율이 높은 세그먼트에 우선 집중하면 같은 발송량으로 더 많은 미팅을 만들 수 있습니다.
        </p>
      </Card>
    </div>
  )
}

function FunnelCard({
  label, value, sub, loading,
}: { label: string; value: number; sub: string | null; loading: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mt-2" />
      ) : (
        <>
          <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
          {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
        </>
      )}
    </Card>
  )
}
