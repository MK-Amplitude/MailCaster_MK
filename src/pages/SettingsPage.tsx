// ============================================================
// SettingsPage — 프로필 / 발송 기본값 / Slack 알림 / 계정
// ------------------------------------------------------------
// profiles 테이블의 편집 가능한 필드를 섹션별로 노출한다.
//
// 섹션 구성:
//   1. 프로필 — display_name (email 은 readonly)
//   2. 발송 기본값 — default_sender_name / default_cc / default_bcc / daily_send_limit
//   3. Slack 알림 — slack_webhook_url / slack_channel_name
//   4. 일일 발송 현황 — daily_send_count (readonly, 진행 bar)
//   5. 계정 — 로그아웃
//
// 저장 UX:
//   - 섹션마다 독립적으로 "저장" 하지 않고, 하단 고정 바에 "변경 사항 저장"
//     버튼 하나를 두어 변경된 필드만 한 번에 commit.
//   - dirty 체크: 초기 값과 현재 값 비교. JSON.stringify 로 간단히.
// ============================================================

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { useAuth } from '@/hooks/useAuth'
import { useProfile, useUpdateProfile, type ProfileEditable } from '@/hooks/useProfile'
import {
  Settings as SettingsIcon,
  User as UserIcon,
  Send,
  Bell,
  Activity,
  LogOut,
  Save,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDate } from '@/lib/utils'

// UI state 의 타입. 폼은 모두 string 으로 다루고, 저장 시점에 number 로 변환.
interface FormState {
  display_name: string
  default_sender_name: string
  default_cc: string
  default_bcc: string
  slack_webhook_url: string
  slack_channel_name: string
  daily_send_limit: string
}

function toForm(p: ReturnType<typeof useProfile>['data']): FormState {
  return {
    display_name: p?.display_name ?? '',
    default_sender_name: p?.default_sender_name ?? '',
    default_cc: p?.default_cc ?? '',
    default_bcc: p?.default_bcc ?? '',
    slack_webhook_url: p?.slack_webhook_url ?? '',
    slack_channel_name: p?.slack_channel_name ?? '',
    daily_send_limit: String(p?.daily_send_limit ?? 1500),
  }
}

export default function SettingsPage() {
  const { user, signOut } = useAuth()
  const { data: profile, isLoading } = useProfile()
  const updateMut = useUpdateProfile()

  // 서버 값 → form 초기화. 서버 값이 바뀌면(다른 탭 저장 등) 동기화.
  const initialForm = useMemo(() => toForm(profile), [profile])
  const [form, setForm] = useState<FormState>(initialForm)

  useEffect(() => {
    setForm(initialForm)
  }, [initialForm])

  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm)

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleReset = () => setForm(initialForm)

  const handleSave = async () => {
    // daily_send_limit 검증 — 숫자/양수/상한
    const limitNum = parseInt(form.daily_send_limit, 10)
    if (!Number.isFinite(limitNum) || limitNum < 1 || limitNum > 10000) {
      toast.error('일일 발송 한도는 1~10000 사이의 숫자여야 합니다.')
      return
    }

    const updates: ProfileEditable = {
      display_name: form.display_name,
      default_sender_name: form.default_sender_name,
      default_cc: form.default_cc,
      default_bcc: form.default_bcc,
      slack_webhook_url: form.slack_webhook_url,
      slack_channel_name: form.slack_channel_name,
      daily_send_limit: limitNum,
    }
    try {
      await updateMut.mutateAsync(updates)
    } catch {
      // onError 에서 토스트
    }
  }

  // 일일 발송 현황 — 오늘 카운트가 유효한 경우에만 진행 bar 표시
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const todayCount =
    profile?.daily_send_count_date === today ? profile?.daily_send_count ?? 0 : 0
  const limit = profile?.daily_send_limit ?? 1500
  const usagePct = Math.min(100, Math.round((todayCount / limit) * 100))

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <SettingsIcon className="w-5 h-5" />
          설정
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          프로필 정보와 캠페인 기본값을 관리합니다.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6 pb-28">
          {isLoading || !profile ? (
            <div className="space-y-4">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-60 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <>
              {/* 1. 프로필 */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <UserIcon className="w-4 h-4" />
                    프로필
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="email">이메일</Label>
                    <Input id="email" value={profile.email} disabled readOnly />
                    <p className="text-xs text-muted-foreground">
                      Google 계정에 연결된 주소 — 변경할 수 없습니다.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="display_name">표시 이름</Label>
                    <Input
                      id="display_name"
                      value={form.display_name}
                      onChange={(e) => setField('display_name', e.target.value)}
                      placeholder="예: 홍길동"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* 2. 발송 기본값 */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Send className="w-4 h-4" />
                    발송 기본값
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    새 캠페인을 생성할 때 자동으로 채워지는 값입니다. 캠페인마다
                    개별적으로 덮어쓸 수 있습니다.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="sender_name">발신자 이름 (From Name)</Label>
                    <Input
                      id="sender_name"
                      value={form.default_sender_name}
                      onChange={(e) =>
                        setField('default_sender_name', e.target.value)
                      }
                      placeholder="예: MailCaster 팀"
                    />
                    <p className="text-xs text-muted-foreground">
                      수신자의 받은편지함에 표시될 이름. 비워두면 Google 계정
                      이름이 쓰입니다.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="default_cc">기본 CC</Label>
                      <Input
                        id="default_cc"
                        value={form.default_cc}
                        onChange={(e) => setField('default_cc', e.target.value)}
                        placeholder="team@example.com"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="default_bcc">기본 BCC</Label>
                      <Input
                        id="default_bcc"
                        value={form.default_bcc}
                        onChange={(e) => setField('default_bcc', e.target.value)}
                        placeholder="archive@example.com"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="daily_limit">일일 발송 한도</Label>
                    <Input
                      id="daily_limit"
                      type="number"
                      min={1}
                      max={10000}
                      value={form.daily_send_limit}
                      onChange={(e) =>
                        setField('daily_send_limit', e.target.value)
                      }
                      className="w-40"
                    />
                    <p className="text-xs text-muted-foreground">
                      Gmail 계정 타입에 따른 권장: 일반 500, Workspace 2000. 이
                      한도를 넘는 발송은 자동으로 차단됩니다.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* 3. Slack 알림 */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Bell className="w-4 h-4" />
                    Slack 알림
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    캠페인 발송 완료 / 실패 / 답장 감지 시 Slack 으로 알림을
                    받습니다. Webhook URL 이 비어있으면 알림은 보내지 않습니다.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="slack_webhook">Incoming Webhook URL</Label>
                    <Input
                      id="slack_webhook"
                      type="url"
                      value={form.slack_webhook_url}
                      onChange={(e) =>
                        setField('slack_webhook_url', e.target.value)
                      }
                      placeholder="https://hooks.slack.com/services/..."
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="slack_channel">채널 이름 (표시용)</Label>
                    <Input
                      id="slack_channel"
                      value={form.slack_channel_name}
                      onChange={(e) =>
                        setField('slack_channel_name', e.target.value)
                      }
                      placeholder="#mailcaster-alerts"
                    />
                    <p className="text-xs text-muted-foreground">
                      실제 대상 채널은 Webhook 이 결정합니다. 여기는 UI 표시용.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* 4. 일일 발송 현황 */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Activity className="w-4 h-4" />
                    오늘 발송 현황
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-2xl font-bold tabular-nums">
                      {todayCount.toLocaleString()}
                    </span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      / {limit.toLocaleString()} 통
                    </span>
                  </div>
                  <Progress value={usagePct} />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{usagePct}% 사용</span>
                    <span>
                      기준일: {formatDate(profile.daily_send_count_date) || '—'}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* 5. 계정 */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">계정</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{user?.email}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        가입일 {formatDate(profile.created_at)}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        await signOut()
                      }}
                    >
                      <LogOut className="w-3.5 h-3.5 mr-1.5" />
                      로그아웃
                    </Button>
                  </div>
                  <Separator />
                  <p className="text-xs text-muted-foreground">
                    계정 삭제 / 데이터 초기화가 필요하신 경우 관리자에게
                    문의해주세요.
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      {/* 변경 사항 저장 바 — dirty 일 때만 등장.
          pb-3-safe: 하단 padding 에 iOS 홈바 inset 을 더해 버튼이 가려지지 않음. */}
      {dirty && (
        <div className="border-t bg-card px-6 pt-3 pb-3-safe flex items-center justify-between gap-3 sticky bottom-0">
          <span className="text-sm text-muted-foreground">
            저장되지 않은 변경 사항이 있습니다.
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={updateMut.isPending}
            >
              <Undo2 className="w-3.5 h-3.5 mr-1.5" />
              되돌리기
            </Button>
            <Button size="sm" onClick={handleSave} disabled={updateMut.isPending}>
              <Save className="w-3.5 h-3.5 mr-1.5" />
              {updateMut.isPending ? '저장 중...' : '저장'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
