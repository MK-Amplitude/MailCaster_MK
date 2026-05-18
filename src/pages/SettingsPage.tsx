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
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  Building2,
  History,
} from 'lucide-react'
import { useAuditLog } from '@/hooks/useAuditLog'
import { format, formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'
import { toast } from 'sonner'
import { formatDate } from '@/lib/utils'
import { OrganizationSettings } from '@/components/settings/OrganizationSettings'
import {
  useOutreachStatus,
  useOutreachDisconnect,
  getOutreachAuthUrl,
} from '@/hooks/useOutreach'
import { Link2, Link2Off, ExternalLink } from 'lucide-react'

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

  // ?tab=organization 으로 딥링크 지원 (OrgSwitcher 에서 호출)
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const activeTab = rawTab === 'organization' ? 'organization' : 'profile'
  const setActiveTab = (value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === 'profile') next.delete('tab')
    else next.set('tab', value)
    setSearchParams(next, { replace: true })
  }

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
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="profile">
                <UserIcon className="w-3.5 h-3.5 mr-1.5" />
                프로필
              </TabsTrigger>
              <TabsTrigger value="organization">
                <Building2 className="w-3.5 h-3.5 mr-1.5" />
                조직
              </TabsTrigger>
              <TabsTrigger value="audit">
                <History className="w-3.5 h-3.5 mr-1.5" />
                활동 내역
              </TabsTrigger>
            </TabsList>

            <TabsContent value="profile" className="space-y-6 mt-4">
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

              {/* 4.5 외부 연동 — Outreach */}
              <OutreachSection />

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
            </TabsContent>

            <TabsContent value="organization" className="mt-4">
              <OrganizationSettings />
            </TabsContent>
            <TabsContent value="audit" className="mt-4">
              <AuditLogSection />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* 변경 사항 저장 바 — dirty 일 때만 등장. profile 탭에서만 의미있음.
          pb-3-safe: 하단 padding 에 iOS 홈바 inset 을 더해 버튼이 가려지지 않음. */}
      {dirty && activeTab === 'profile' && (
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

// ─────────────────────────────────────────────────────────────────────────────
// 활동 내역 — audit_log (035) 의 최근 50건.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_LABEL: Record<string, string> = {
  campaigns: '캠페인',
  contacts: '연락처',
  groups: '그룹',
  signatures: '서명',
  templates: '템플릿',
}

const ACTION_LABEL: Record<string, string> = {
  insert: '생성',
  update: '수정',
  delete: '삭제',
}

const ACTION_COLOR: Record<string, string> = {
  insert: 'text-emerald-700 dark:text-emerald-300',
  update: 'text-blue-700 dark:text-blue-300',
  delete: 'text-rose-700 dark:text-rose-300',
}

function AuditLogSection() {
  const { data: rows = [], isLoading } = useAuditLog({ limit: 50 })

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        아직 기록된 활동이 없습니다. 캠페인·연락처·그룹·서명·템플릿이 생성/수정/삭제될 때마다
        자동 기록됩니다.
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground mb-2">
        조직의 최근 변경 활동 50건. 캠페인·연락처·그룹·서명·템플릿의 생성/수정/삭제가 자동 기록됩니다.
      </p>
      {rows.map((r) => {
        const targetLabel = TARGET_LABEL[r.target_type] ?? r.target_type
        const actionLabel = ACTION_LABEL[r.action] ?? r.action
        const actionColor = ACTION_COLOR[r.action] ?? 'text-foreground'
        const who = r.user_name ?? r.user_email ?? '시스템'
        const when = new Date(r.created_at)
        const changedKeys = r.diff?.after ? Object.keys(r.diff.after) : []
        return (
          <div
            key={r.id}
            className="rounded-md border bg-card px-3 py-2 flex items-start gap-2"
          >
            <Activity className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-sm font-medium truncate">{who}</span>
                <span className="text-xs text-muted-foreground">
                  님이 {targetLabel}
                </span>
                <span className={`text-xs font-medium ${actionColor}`}>{actionLabel}</span>
                <span
                  className="text-[11px] text-muted-foreground tabular-nums"
                  title={format(when, 'yyyy-MM-dd HH:mm:ss', { locale: ko })}
                >
                  · {formatDistanceToNow(when, { addSuffix: true, locale: ko })}
                </span>
              </div>
              {r.action === 'update' && changedKeys.length > 0 && (
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                  변경 컬럼: {changedKeys.join(', ')}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 외부 연동 — Outreach
// ─────────────────────────────────────────────────────────────────────────────

function OutreachSection() {
  const { data: status, isLoading } = useOutreachStatus()
  const disconnect = useOutreachDisconnect()

  const handleConnect = () => {
    // redirect_uri 는 GitHub Pages basename 포함. window.location.origin + basename + 'outreach/callback'.
    const redirectUri = `${window.location.origin}${import.meta.env.BASE_URL}outreach/callback`.replace(
      /\/+$/,
      '',
    )
    const state = crypto.randomUUID()
    const authUrl = getOutreachAuthUrl(redirectUri, state)
    if (!authUrl) {
      toast.error(
        'Outreach 연동이 서버에 설정되지 않았습니다. 관리자에게 VITE_OUTREACH_CLIENT_ID 설정을 요청하세요.',
      )
      return
    }
    // 같은 창에서 이동 — popup 차단 회피.
    window.location.href = authUrl
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Link2 className="w-4 h-4" />
          외부 연동 — Outreach
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          연결하면 앞으로 발송하는 모든 메일이 Outreach 의 해당 prospect activity 에 자동
          기록됩니다. 동일 email 의 prospect 가 없으면 새로 생성됩니다.
        </p>

        {isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : status?.connected ? (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 text-xs">
                <Link2 className="w-3 h-3" />
                연결됨
              </span>
              {status.connected_at && (
                <span className="text-xs text-muted-foreground">
                  {format(new Date(status.connected_at), 'yyyy.MM.dd HH:mm')}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              <Link2Off className="w-3.5 h-3.5 mr-1.5" />
              연결 해제
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={handleConnect}>
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
            Outreach 연결하기
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
