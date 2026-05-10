// 캠페인 발송 시점 선택 — 즉시 발송 / 예약 발송.
// datetime-local input 으로 분 단위 선택. 최소값은 현재 + 2분 (cron 1분 주기 여유).

import { useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { CalendarClock, Clock } from 'lucide-react'
import {
  toLocalInputValue,
  fromLocalInputValue,
  formatRelativeFuture,
} from './helpers'

interface Props {
  scheduledAt: string | null
  setScheduledAt: (v: string | null) => void
  hasAttachments: boolean
}

export function ScheduleSection({ scheduledAt, setScheduledAt, hasAttachments }: Props) {
  const isScheduled = scheduledAt !== null
  const minLocal = useMemo(() => {
    const d = new Date(Date.now() + 2 * 60_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }, [])

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <CalendarClock className="w-3.5 h-3.5" />
        발송 시점
      </Label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Card
          className={`cursor-pointer transition-colors ${!isScheduled ? 'border-primary bg-primary/5' : ''}`}
          onClick={() => setScheduledAt(null)}
        >
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Checkbox checked={!isScheduled} />
              <span className="text-sm font-medium">즉시 발송</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              초안으로 저장한 뒤 "발송하기" 버튼을 눌러 지금 바로 발송합니다.
            </p>
          </CardContent>
        </Card>
        <Card
          className={`cursor-pointer transition-colors ${isScheduled ? 'border-primary bg-primary/5' : ''}`}
          onClick={() => {
            if (!isScheduled) {
              // 기본값: 현재 + 10분 (분 단위로 반올림)
              const d = new Date(Date.now() + 10 * 60_000)
              d.setSeconds(0, 0)
              setScheduledAt(d.toISOString())
            }
          }}
        >
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Checkbox checked={isScheduled} />
              <span className="text-sm font-medium">예약 발송</span>
              <Badge variant="secondary" className="text-[10px]">
                <Clock className="w-3 h-3 mr-0.5" />
                자동
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              지정한 시각에 서버가 자동으로 발송합니다. 창을 닫아도 동작합니다.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Phase 5: 첨부 + 예약 지원됨 — 안내 배너 */}
      {isScheduled && hasAttachments && (
        <p className="text-xs text-blue-700 dark:text-blue-300 bg-blue-50/60 dark:bg-blue-950/20 rounded p-2">
          📎 첨부 파일은 예약된 시각에 Google Drive 에서 자동으로 처리됩니다. 총 15MB 를 초과하는
          첨부는 Drive 공유 링크로 전환되어 본문에 포함됩니다.
        </p>
      )}

      {isScheduled && (
        <div className="space-y-1.5 pt-1">
          <Label className="text-xs">발송 예정 일시 (내 PC 시간 기준)</Label>
          <Input
            type="datetime-local"
            value={toLocalInputValue(scheduledAt)}
            min={minLocal}
            onChange={(e) => setScheduledAt(fromLocalInputValue(e.target.value))}
            className="max-w-[260px]"
          />
          {scheduledAt && (
            <p className="text-xs text-muted-foreground">
              {new Date(scheduledAt).toLocaleString('ko-KR', {
                weekday: 'short',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              (약 {formatRelativeFuture(scheduledAt)} 뒤)
            </p>
          )}
        </div>
      )}
    </div>
  )
}
