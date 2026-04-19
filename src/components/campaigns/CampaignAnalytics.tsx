// CampaignAnalytics
// ------------------------------------------------------------
// 캠페인 상세 페이지에 노출되는 분석 섹션.
//   - 요약 카드: 성공률 / 실패율 / 평균 발송 간격 / 총 소요
//   - 도넛:     상태별 분포 (성공 / 실패 / 대기 / 발송 중 / 반송 / 건너뜀)
//   - 라인:     시간대별 누적 성공/실패 (sent_at 기준 분 단위 bucket)
//
// sending 단계에서도 실시간으로 업데이트되도록 recipients 는 부모(CampaignDetailPage)가
// 2초 refetchInterval 로 유지 — 이 컴포넌트는 순수 presentational.
//
// 표시 조건:
//   - recipients 가 하나도 없으면 전체 섹션 숨김 (draft/scheduled 에서 무의미)
//   - sent_at 이 하나도 없으면 시간 차트는 숨기고 도넛만 표시
// ------------------------------------------------------------

import { useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from 'recharts'
import { BarChart3 } from 'lucide-react'
import type { Recipient, RecipientStatus } from '@/types/campaign'

// 같은 RECIPIENT_STATUS_META 를 페이지 쪽과 공유하고 싶지만 거기는 라벨/텍스트색만
// 정의하고 있어 차트 배경색이 없다. 여기서는 차트 전용 팔레트를 별도 유지.
const STATUS_COLORS: Record<RecipientStatus, string> = {
  sent: '#16a34a',      // green-600
  failed: '#dc2626',    // red-600
  pending: '#9ca3af',   // gray-400
  sending: '#f59e0b',   // amber-500
  bounced: '#ea580c',   // orange-600
  skipped: '#64748b',   // slate-500
}

const STATUS_LABELS: Record<RecipientStatus, string> = {
  sent: '성공',
  failed: '실패',
  pending: '대기',
  sending: '발송 중',
  bounced: '반송',
  skipped: '건너뜀',
}

export function CampaignAnalytics({
  recipients,
  /**
   * 캠페인의 open tracking on/off 여부.
   * false 이면 오픈 카운터가 항상 0 이므로 "0%" 대신 "추적 비활성" 으로 표기해 혼동을 방지.
   * 주어지지 않으면 true 로 간주 (하위호환).
   */
  enableOpenTracking = true,
}: {
  recipients: Recipient[]
  enableOpenTracking?: boolean
}) {
  const analytics = useMemo(() => computeAnalytics(recipients), [recipients])

  if (recipients.length === 0) return null

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-1.5">
          <BarChart3 className="w-4 h-4 text-muted-foreground" />
          <div className="text-sm font-semibold">분석</div>
        </div>

        {/* 요약 수치 카드 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric
            label="성공률"
            value={`${analytics.successRate.toFixed(1)}%`}
            tone={analytics.successRate >= 90 ? 'success' : analytics.successRate >= 50 ? 'neutral' : 'danger'}
          />
          <Metric
            label="실패율"
            value={`${analytics.failureRate.toFixed(1)}%`}
            tone={analytics.failureRate === 0 ? 'success' : analytics.failureRate < 10 ? 'neutral' : 'danger'}
          />
          <Metric
            label="오픈율"
            value={
              !enableOpenTracking
                ? '비활성'
                : analytics.sentCount > 0
                ? `${analytics.openRate.toFixed(1)}%`
                : '-'
            }
            subValue={
              !enableOpenTracking
                ? '오픈 추적 꺼짐'
                : analytics.sentCount > 0
                ? `${analytics.openedCount}/${analytics.sentCount}`
                : undefined
            }
            tone={
              !enableOpenTracking || analytics.sentCount === 0
                ? 'neutral'
                : analytics.openRate >= 40
                ? 'success'
                : analytics.openRate >= 15
                ? 'neutral'
                : 'danger'
            }
          />
          <Metric
            label="답장률"
            value={
              analytics.sentCount > 0
                ? `${analytics.replyRate.toFixed(1)}%`
                : '-'
            }
            subValue={
              analytics.sentCount > 0
                ? `${analytics.repliedCount}/${analytics.sentCount}`
                : undefined
            }
            tone={
              analytics.sentCount === 0
                ? 'neutral'
                : analytics.replyRate >= 10
                ? 'success'
                : analytics.replyRate >= 3
                ? 'neutral'
                : 'danger'
            }
          />
        </div>

        {/* 보조 수치 카드 — 속도 관련 지표 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric
            label="평균 발송 간격"
            value={analytics.avgGapLabel}
            tone="neutral"
          />
          <Metric
            label="총 소요 시간"
            value={analytics.totalDurationLabel}
            tone="neutral"
          />
          <Metric
            label="반송"
            value={`${analytics.bouncedCount}명`}
            tone={analytics.bouncedCount === 0 ? 'success' : 'danger'}
          />
          <Metric
            label="누적 오픈"
            value={`${analytics.totalOpenEvents}회`}
            subValue={
              analytics.openedCount > 0
                ? `평균 ${(analytics.totalOpenEvents / analytics.openedCount).toFixed(1)}회/명`
                : undefined
            }
            tone="neutral"
          />
        </div>

        {/* 도넛 + 시계열 차트 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted-foreground mb-2">상태별 분포</div>
            <div className="h-52">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={analytics.donutData}
                    dataKey="value"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {analytics.donutData.map((d) => (
                      <Cell key={d.status} fill={STATUS_COLORS[d.status]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v, _n, entry) => {
                      // recharts 타입상 payload.status 접근은 any 로만
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const status = (entry as any)?.payload?.status as RecipientStatus | undefined
                      const count = typeof v === 'number' ? v : Number(v) || 0
                      return [`${count}명`, status ? STATUS_LABELS[status] : '']
                    }}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={24}
                    iconSize={8}
                    formatter={(value) =>
                      STATUS_LABELS[value as RecipientStatus] ?? value
                    }
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {analytics.hasTimeline ? (
            <div>
              <div className="text-xs text-muted-foreground mb-2">시간대별 누적</div>
              <div className="h-52">
                <ResponsiveContainer>
                  <LineChart data={analytics.timeline}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="sent"
                      stroke={STATUS_COLORS.sent}
                      strokeWidth={2}
                      name="누적 성공"
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="failed"
                      stroke={STATUS_COLORS.failed}
                      strokeWidth={2}
                      name="누적 실패"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground self-center">
              발송이 시작되면 시간대별 차트가 여기에 나타납니다.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------
// analytics 계산 — 순수 함수, useMemo 로 감쌀 수 있게 분리
// ------------------------------------------------------------
function computeAnalytics(recipients: Recipient[]) {
  const total = recipients.length
  const byStatus = new Map<RecipientStatus, number>()
  for (const r of recipients) {
    const s = r.status as RecipientStatus
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1)
  }

  const sentCount = byStatus.get('sent') ?? 0
  const failedCount = byStatus.get('failed') ?? 0
  const processed = sentCount + failedCount
  const successRate = processed > 0 ? (sentCount / processed) * 100 : 0
  const failureRate = processed > 0 ? (failedCount / processed) * 100 : 0

  // Phase 6 (C) — 오픈 / 답장 / 반송 통계
  //   분모는 "실제 발송된(sent) 수" — 실패/대기 제외.
  //   오픈율 = unique opens / sent. 답장률 = unique replies / sent.
  let openedCount = 0
  let repliedCount = 0
  let bouncedCount = 0
  let totalOpenEvents = 0
  for (const r of recipients) {
    if (r.status === 'sent') {
      if (r.opened) openedCount++
      if (r.replied) repliedCount++
    }
    if (r.status === 'bounced' || r.bounced) bouncedCount++
    totalOpenEvents += r.open_count ?? 0
  }
  const openRate = sentCount > 0 ? (openedCount / sentCount) * 100 : 0
  const replyRate = sentCount > 0 ? (repliedCount / sentCount) * 100 : 0

  // 도넛 데이터 — 0 인 상태는 제외해 레전드를 깔끔하게
  const donutData = (['sent', 'failed', 'pending', 'sending', 'bounced', 'skipped'] as const)
    .map((status) => ({ status, value: byStatus.get(status) ?? 0, label: status }))
    .filter((d) => d.value > 0)

  // 시계열 — sent_at 있는 것만 정렬해 누적 라인 계산
  //   timeline[i] = { label, sent: <i 번째까지 누적 sent>, failed: <누적 failed> }
  //
  // 실패는 sent_at 이 없으므로 failed recipient 는 현재 단순히 "마지막 발송 시각" 에 합쳐 표시
  // (더 정확하게 하려면 실패 타임스탬프 컬럼이 필요 — 다음 iteration)
  const sentRec = recipients
    .filter((r) => r.sent_at && r.status === 'sent')
    .sort((a, b) => new Date(a.sent_at!).getTime() - new Date(b.sent_at!).getTime())
  const hasTimeline = sentRec.length > 0

  let timeline: Array<{ label: string; sent: number; failed: number }> = []
  let avgGapMs = 0
  let totalDurationMs = 0
  if (hasTimeline) {
    const first = new Date(sentRec[0].sent_at!).getTime()
    const last = new Date(sentRec[sentRec.length - 1].sent_at!).getTime()
    totalDurationMs = last - first
    avgGapMs = sentRec.length > 1 ? totalDurationMs / (sentRec.length - 1) : 0

    // 데이터 양에 따라 bucket 방식 결정:
    //   <= 40 포인트: 각 발송을 개별 포인트로 (cumulative)
    //   > 40 포인트: 20개 bucket 으로 압축 (X 축 혼잡 방지)
    if (sentRec.length <= 40) {
      let sentCum = 0
      timeline = sentRec.map((r) => {
        sentCum++
        return {
          label: shortTime(r.sent_at!),
          sent: sentCum,
          failed: 0, // 실패는 마지막에 몰아서 표시 (아래)
        }
      })
    } else {
      const BUCKETS = 20
      const span = Math.max(1, last - first)
      const step = span / BUCKETS
      const counts = Array.from({ length: BUCKETS }, (_, i) => ({
        start: first + step * i,
        end: first + step * (i + 1),
        sent: 0,
      }))
      for (const r of sentRec) {
        const t = new Date(r.sent_at!).getTime()
        const idx = Math.min(BUCKETS - 1, Math.floor((t - first) / step))
        counts[idx].sent++
      }
      let cum = 0
      timeline = counts.map((b) => {
        cum += b.sent
        return {
          label: shortTime(new Date(b.end).toISOString()),
          sent: cum,
          failed: 0,
        }
      })
    }
    // 실패는 마지막 포인트에 누적 표시 (근사)
    if (timeline.length > 0) timeline[timeline.length - 1].failed = failedCount
  }

  return {
    total,
    sentCount,
    failedCount,
    openedCount,
    repliedCount,
    bouncedCount,
    totalOpenEvents,
    successRate,
    failureRate,
    openRate,
    replyRate,
    donutData,
    timeline,
    hasTimeline,
    avgGapLabel: hasTimeline && sentRec.length > 1 ? formatMs(avgGapMs) : '-',
    totalDurationLabel: hasTimeline ? formatMs(totalDurationMs) : '-',
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatMs(ms: number): string {
  if (ms <= 0) return '-'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec > 0 ? `${min}분 ${remSec}초` : `${min}분`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return remMin > 0 ? `${hr}시간 ${remMin}분` : `${hr}시간`
}

function Metric({
  label,
  value,
  subValue,
  tone,
}: {
  label: string
  value: string
  subValue?: string
  tone: 'success' | 'neutral' | 'danger'
}) {
  const toneClass =
    tone === 'success'
      ? 'text-green-600 dark:text-green-400'
      : tone === 'danger'
        ? 'text-red-600 dark:text-red-400'
        : 'text-foreground'
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${toneClass}`}>{value}</div>
      {subValue && (
        <div className="text-[10px] text-muted-foreground mt-0.5">{subValue}</div>
      )}
    </div>
  )
}
