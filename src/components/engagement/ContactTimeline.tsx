// 연락처별 unified timeline — 메일 발송 이력 + 수동 노트 (통화/미팅/메모).
// 모두 발생 시각(occurred_at / sent_at) 기준으로 한 줄에 시간순 표시.
//
// 메일은 ContactSendHistory 의 표시 로직을 그대로 옮겨와 사용 (답장 분류 badge,
// Gmail 새 탭 점프 등 모두 보존). 노트는 본인이 작성한 것만 수정/삭제 가능 — RLS
// 가 강제하지만 UI 에서도 owner_user_id 매칭으로 button 가시성 제어.

import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import {
  Eye,
  Reply,
  AlertOctagon,
  Mail,
  ExternalLink,
  Phone,
  Users,
  StickyNote,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  X,
  Calendar,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/hooks/useAuth'
import { useContactSendHistory, type SendHistoryRow } from '@/hooks/useContactSendHistory'
import {
  useContactNotes,
  useCreateContactNote,
  useUpdateContactNote,
  useDeleteContactNote,
} from '@/hooks/useContactNotes'
import {
  useContactCalendarEvents,
  type CalendarEvent,
} from '@/hooks/useContactCalendarEvents'
import {
  CONTACT_NOTE_OPTIONS,
  contactNoteOption,
  type ContactNote,
  type ContactNoteKind,
} from '@/types/contactNote'
import { replyCategoryOption } from '@/types/replyCategory'
import { cn } from '@/lib/utils'

interface Props {
  contactId: string | null | undefined
  /** Calendar 이벤트 검색용 — undefined 면 calendar 로딩 skip. */
  contactEmail?: string | null
  /** 메일 표시 limit — 메일은 보통 많아 별도 cap. */
  emailLimit?: number
}

function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`
}

const KIND_ICON = { Phone, Users, StickyNote } as const

// 통합 timeline 의 단일 row.
type TimelineItem =
  | { kind: 'email'; date: string; data: SendHistoryRow }
  | { kind: 'note'; date: string; data: ContactNote }
  | { kind: 'event'; date: string; data: CalendarEvent }

export function ContactTimeline({ contactId, contactEmail, emailLimit = 8 }: Props) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { data: emails = [], isLoading: emailsLoading } = useContactSendHistory(contactId)
  const { data: notes = [], isLoading: notesLoading } = useContactNotes(contactId)
  const { data: calendarData, isLoading: eventsLoading } = useContactCalendarEvents(
    contactEmail ?? null
  )
  // useMemo deps 안정화 — calendarData 가 undefined → null 로 매 렌더 새 array 생성 방지
  const events = useMemo(() => calendarData?.events ?? [], [calendarData?.events])
  const calendarScopeMissing = calendarData?.scope_missing === true

  const [composing, setComposing] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // 메일 + 노트 + 캘린더 이벤트를 시간순 merge.
  const items = useMemo<TimelineItem[]>(() => {
    const eitems: TimelineItem[] = emails.slice(0, emailLimit).map((e) => ({
      kind: 'email',
      date: e.sent_at ?? '',
      data: e,
    }))
    const nitems: TimelineItem[] = notes.map((n) => ({
      kind: 'note',
      date: n.occurred_at,
      data: n,
    }))
    const cItems: TimelineItem[] = events
      .filter((e) => e.start_at)
      .map((e) => ({
        kind: 'event',
        date: e.start_at!,
        data: e,
      }))
    const all = [...eitems, ...nitems, ...cItems]
    all.sort((a, b) => {
      if (!a.date && !b.date) return 0
      if (!a.date) return 1
      if (!b.date) return -1
      return new Date(b.date).getTime() - new Date(a.date).getTime()
    })
    return all
  }, [emails, notes, events, emailLimit])

  const isLoading = emailsLoading || notesLoading || eventsLoading
  const hidden = emails.length - Math.min(emails.length, emailLimit)

  return (
    <div className="space-y-2">
      {/* Calendar scope 미부여 안내 — 한 번 더 로그인하면 미팅이 timeline 에 인입 */}
      {calendarScopeMissing && (
        <div className="rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <Calendar className="w-3.5 h-3.5 text-blue-700 dark:text-blue-300 shrink-0" />
            <span className="text-blue-700 dark:text-blue-300 flex-1">
              Google Calendar 연동 — 다시 로그인 시 미팅이 자동 표시됩니다
            </span>
          </div>
        </div>
      )}
      {/* 노트 추가 — 항상 상단에 보이는 trigger */}
      {!composing && contactId && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full h-8 text-xs"
          onClick={() => setComposing(true)}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          통화·미팅·메모 기록
        </Button>
      )}
      {composing && contactId && (
        <NoteForm
          contactId={contactId}
          onClose={() => setComposing(false)}
        />
      )}

      {/* timeline */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center">
          <Mail className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
          <p className="text-xs text-muted-foreground">
            아직 활동 기록이 없습니다.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => {
            if (it.kind === 'email') {
              return (
                <EmailRow
                  key={`e-${it.data.recipient_id}`}
                  email={it.data}
                  onClickRow={() => navigate(`/campaigns/${it.data.campaign_id}`)}
                />
              )
            }
            if (it.kind === 'event') {
              return <EventRow key={`v-${it.data.id}`} event={it.data} />
            }
            return (
              <NoteRow
                key={`n-${it.data.id}`}
                note={it.data}
                isOwner={it.data.user_id === user?.id}
                editing={editingId === it.data.id}
                onStartEdit={() => setEditingId(it.data.id)}
                onCancelEdit={() => setEditingId(null)}
              />
            )
          })}
          {hidden > 0 && (
            <p className="text-[11px] text-muted-foreground text-center pt-1">
              메일 +{hidden}건 더 (캠페인 페이지에서 확인)
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 메일 row
// ─────────────────────────────────────────────────────────────

function EmailRow({
  email: h,
  onClickRow,
}: {
  email: SendHistoryRow
  onClickRow: () => void
}) {
  const replyUrl = h.replied && h.gmail_thread_id ? gmailThreadUrl(h.gmail_thread_id) : null
  const categoryOpt = h.replied ? replyCategoryOption(h.reply_category) : null
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClickRow}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClickRow()
        }
      }}
      className="w-full text-left rounded-md border bg-card hover:bg-muted/40 transition-colors p-2 flex items-start gap-2 cursor-pointer"
    >
      <Mail className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-medium truncate">{h.campaign_name}</span>
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            {h.sent_at ? format(new Date(h.sent_at), 'MM/dd HH:mm', { locale: ko }) : '—'}
          </span>
        </div>
        {h.campaign_subject && (
          <p className="text-[11px] text-muted-foreground truncate">{h.campaign_subject}</p>
        )}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <ResultBadge
            icon={Eye}
            active={h.opened}
            label={h.opened ? `오픈 ${h.open_count > 1 ? h.open_count : ''}`.trim() : '미오픈'}
            tone={h.opened ? 'positive' : 'muted'}
          />
          {replyUrl ? (
            <a
              href={replyUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[10px] tabular-nums text-emerald-700 dark:text-emerald-300 hover:underline"
              title="Gmail 새 탭에서 답장 보기"
            >
              <Reply className="w-3 h-3" />
              답장
              <ExternalLink className="w-2.5 h-2.5 opacity-70" />
            </a>
          ) : (
            <ResultBadge
              icon={Reply}
              active={h.replied}
              label={h.replied ? '답장' : '답장 없음'}
              tone={h.replied ? 'positive' : 'muted'}
            />
          )}
          {categoryOpt && (
            <span
              className={cn(
                'inline-flex items-center text-[10px] px-1.5 py-0 h-4 rounded border',
                categoryOpt.className
              )}
              title={categoryOpt.hint}
            >
              {categoryOpt.label}
            </span>
          )}
          {/* 내 답장 대기 — 고객이 답장했는데 내 답장이 마지막이 아닐 때 강조.
              null (cron pass2 미반영) 도 보수적으로 "대기" 로 표시. */}
          {h.replied && h.last_thread_message_from_me !== true && (
            <span
              className="inline-flex items-center text-[10px] px-1.5 py-0 h-4 rounded border bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border-rose-200 dark:border-rose-800"
              title="고객이 답장했는데 내가 아직 답장 안 함 — 회신 필요"
            >
              내 답장 대기
            </span>
          )}
          {h.bounced && <ResultBadge icon={AlertOctagon} active label="반송" tone="critical" />}
        </div>
      </div>
    </div>
  )
}

function ResultBadge({
  icon: Icon,
  active,
  label,
  tone,
}: {
  icon: React.ElementType
  active: boolean
  label: string
  tone: 'positive' | 'muted' | 'critical'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] tabular-nums',
        tone === 'positive' && active && 'text-emerald-700 dark:text-emerald-300',
        tone === 'critical' && 'text-rose-700 dark:text-rose-300',
        (tone === 'muted' || !active) && tone !== 'critical' && 'text-muted-foreground'
      )}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// 캘린더 이벤트 row
// ─────────────────────────────────────────────────────────────

function EventRow({ event }: { event: CalendarEvent }) {
  const start = event.start_at ? new Date(event.start_at) : null
  const end = event.end_at ? new Date(event.end_at) : null
  const isAllDay = !!(
    event.start_at && /^\d{4}-\d{2}-\d{2}$/.test(event.start_at)
  )
  // 진행 상태 — past / current / future
  const now = Date.now()
  const isPast = start ? start.getTime() < now : false
  const link = event.html_link
  const handleClick = () => {
    if (link) window.open(link, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      role={link ? 'button' : undefined}
      tabIndex={link ? 0 : undefined}
      onClick={link ? handleClick : undefined}
      onKeyDown={
        link
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleClick()
              }
            }
          : undefined
      }
      className={cn(
        'rounded-md border bg-card p-2 flex items-start gap-2',
        link && 'cursor-pointer hover:bg-muted/40 transition-colors'
      )}
    >
      <Calendar className="w-3.5 h-3.5 text-blue-700 dark:text-blue-300 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'inline-flex items-center text-[10px] px-1.5 py-0 h-4 rounded border',
              'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            )}
          >
            미팅
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            {start
              ? format(start, isAllDay ? 'MM/dd' : 'MM/dd HH:mm', { locale: ko })
              : '—'}
            {end && start && !isAllDay
              ? ` ~ ${format(end, 'HH:mm', { locale: ko })}`
              : ''}
          </span>
          {isPast && (
            <span className="text-[10px] text-muted-foreground">· 지난 미팅</span>
          )}
        </div>
        <p className="text-sm font-medium truncate mt-0.5">
          {event.summary ?? '(제목 없음)'}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          {event.attendees_count > 0 && (
            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
              <Users className="w-2.5 h-2.5" />
              {event.attendees_count}명
            </span>
          )}
          {link && (
            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
              <ExternalLink className="w-2.5 h-2.5" />
              Google Calendar
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 노트 row + 폼
// ─────────────────────────────────────────────────────────────

function NoteRow({
  note,
  isOwner,
  editing,
  onStartEdit,
  onCancelEdit,
}: {
  note: ContactNote
  isOwner: boolean
  editing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
}) {
  const opt = contactNoteOption(note.kind)
  const Icon = KIND_ICON[opt.icon]
  const del = useDeleteContactNote()

  if (editing) {
    return (
      <NoteForm
        contactId={note.contact_id}
        existing={note}
        onClose={onCancelEdit}
      />
    )
  }

  return (
    <div className="rounded-md border bg-card p-2 flex items-start gap-2 group">
      <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'inline-flex items-center text-[10px] px-1.5 py-0 h-4 rounded border',
              opt.className
            )}
          >
            {opt.label}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            {format(new Date(note.occurred_at), 'MM/dd HH:mm', { locale: ko })}
          </span>
          {isOwner && (
            <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                onClick={onStartEdit}
                title="수정"
              >
                <Pencil className="w-3 h-3" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-rose-600"
                onClick={() => {
                  if (confirm('이 메모를 삭제할까요?')) {
                    del.mutate({ id: note.id, contact_id: note.contact_id })
                  }
                }}
                title="삭제"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )}
        </div>
        <p className="text-sm whitespace-pre-wrap break-words mt-0.5">{note.body}</p>
      </div>
    </div>
  )
}

function NoteForm({
  contactId,
  existing,
  onClose,
}: {
  contactId: string
  existing?: ContactNote
  onClose: () => void
}) {
  const create = useCreateContactNote()
  const update = useUpdateContactNote()
  const [kind, setKind] = useState<ContactNoteKind>(existing?.kind ?? 'note')
  const [body, setBody] = useState(existing?.body ?? '')
  const [occurredAt, setOccurredAt] = useState(
    toLocalInput(existing?.occurred_at ?? new Date().toISOString())
  )

  const submitting = create.isPending || update.isPending
  const valid = body.trim().length > 0

  const handleSubmit = async () => {
    if (!valid) return
    const occurredIso = fromLocalInput(occurredAt) ?? new Date().toISOString()
    try {
      if (existing) {
        await update.mutateAsync({
          id: existing.id,
          contact_id: contactId,
          kind,
          body: body.trim(),
          occurred_at: occurredIso,
        })
      } else {
        await create.mutateAsync({
          contact_id: contactId,
          kind,
          body: body.trim(),
          occurred_at: occurredIso,
        })
      }
      onClose()
    } catch {
      // toast 는 hook 내부 onError 가 처리
    }
  }

  return (
    <div className="rounded-md border bg-muted/30 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as ContactNoteKind)}>
          <SelectTrigger className="h-7 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTACT_NOTE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="datetime-local"
          value={occurredAt}
          onChange={(e) => setOccurredAt(e.target.value)}
          className="h-7 text-xs flex-1 max-w-[180px]"
          title="발생 시각"
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 ml-auto"
          onClick={onClose}
          disabled={submitting}
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="어떤 얘기가 오갔는지 기록..."
        rows={3}
        className="text-sm resize-none"
        autoFocus
        disabled={submitting}
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={onClose} disabled={submitting}>
          취소
        </Button>
        <Button type="button" size="sm" className="h-7 text-xs" onClick={handleSubmit} disabled={!valid || submitting}>
          {submitting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
          {existing ? '수정' : '추가'}
        </Button>
      </div>
    </div>
  )
}

// datetime-local input 변환 (CampaignWizard helpers 와 동일 — 작아서 inline)
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}
