// 시퀀스 자동 발송 가드레일 설정 카드 (Tier2-B).
// 일일 한도 / 업무시간 발송창 / 워밍업 — process-sequences 가 이 값으로 발송을 제어.

import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useSendSettings,
  useUpdateSendSettings,
  DEFAULT_SEND_SETTINGS,
  type SendSettings,
} from '@/hooks/useSendSettings'

export function SendSettingsCard() {
  const { data, isLoading } = useSendSettings()
  const update = useUpdateSendSettings()
  const [form, setForm] = useState<SendSettings>(DEFAULT_SEND_SETTINGS)

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  function setField<K extends keyof SendSettings>(k: K, v: SendSettings[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  const windowInvalid = form.window_end_hour <= form.window_start_hour

  if (isLoading) return <Skeleton className="h-80 w-full" />

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          시퀀스 자동 발송 안전 설정
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          시퀀스(자동 후속) 발송에만 적용됩니다. Gmail 계정 평판 보호를 위해 하루 발송량과
          발송 시간대를 제한합니다. 한도/시간 밖이면 자동으로 다음 가능 시점으로 미뤄집니다.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 일일 한도 */}
        <div className="space-y-1.5">
          <Label htmlFor="daily_send_limit">일일 발송 한도 (최근 24시간, 조직 전체)</Label>
          <Input
            id="daily_send_limit"
            type="number"
            min={0}
            className="max-w-[160px]"
            value={form.daily_send_limit}
            onChange={(e) => setField('daily_send_limit', Math.max(0, Number(e.target.value) || 0))}
          />
          <p className="text-xs text-muted-foreground">
            일반 Gmail 계정은 하루 약 500통 제한이 있습니다. 평판을 위해 보수적으로 설정하세요(권장 50–150).
          </p>
        </div>

        {/* 발송창 */}
        <div className="space-y-1.5">
          <Label>업무시간 발송창</Label>
          <div className="flex items-center gap-2 text-sm">
            <Input
              type="number" min={0} max={23} className="w-20"
              value={form.window_start_hour}
              onChange={(e) => setField('window_start_hour', clamp(Number(e.target.value), 0, 23))}
            />
            <span className="text-muted-foreground">시 ~</span>
            <Input
              type="number" min={1} max={24} className="w-20"
              value={form.window_end_hour}
              onChange={(e) => setField('window_end_hour', clamp(Number(e.target.value), 1, 24))}
            />
            <span className="text-muted-foreground">시</span>
          </div>
          {windowInvalid && (
            <p className="text-xs text-rose-600">종료 시각이 시작 시각보다 커야 합니다.</p>
          )}
        </div>

        {/* 타임존 */}
        <div className="space-y-1.5">
          <Label htmlFor="timezone">기준 시간대</Label>
          <Input
            id="timezone"
            className="max-w-[240px]"
            value={form.timezone}
            onChange={(e) => setField('timezone', e.target.value)}
            placeholder="Asia/Seoul"
          />
          <p className="text-xs text-muted-foreground">IANA 시간대 (예: Asia/Seoul, America/Los_Angeles).</p>
        </div>

        {/* 주말 */}
        <div className="flex items-center justify-between max-w-md">
          <div>
            <Label>주말에도 발송</Label>
            <p className="text-xs text-muted-foreground">끄면 토·일에는 자동 발송을 멈춥니다.</p>
          </div>
          <Switch
            checked={form.send_on_weekends}
            onCheckedChange={(v) => setField('send_on_weekends', v)}
          />
        </div>

        {/* 워밍업 */}
        <div className="space-y-2 border-t pt-4">
          <Label>워밍업 (선택)</Label>
          <p className="text-xs text-muted-foreground">
            새 계정/도메인이면 발송량을 점진적으로 늘려 평판을 보호합니다. 시작값을 0으로 두면 비활성.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="warmup_start" className="text-xs">시작 한도</Label>
              <Input
                id="warmup_start" type="number" min={0}
                value={form.warmup_start}
                onChange={(e) => setField('warmup_start', Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="warmup_per_day" className="text-xs">하루 증가량</Label>
              <Input
                id="warmup_per_day" type="number" min={0}
                value={form.warmup_per_day}
                onChange={(e) => setField('warmup_per_day', Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="warmup_started_at" className="text-xs">시작일</Label>
              <Input
                id="warmup_started_at" type="date"
                value={form.warmup_started_at ?? ''}
                onChange={(e) => setField('warmup_started_at', e.target.value || null)}
              />
            </div>
          </div>
          {form.warmup_start > 0 && form.warmup_started_at && (
            <p className="text-xs text-muted-foreground">
              효과 한도 = min({form.daily_send_limit}, {form.warmup_start} + {form.warmup_per_day}×경과일).
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <Button disabled={windowInvalid || update.isPending} onClick={() => update.mutate(form)}>
            저장
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}
