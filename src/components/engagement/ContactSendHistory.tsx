// 연락처 detail sheet 안에 표시되는 메일 발송 이력 timeline.
// 언제 무슨 캠페인을 보냈고, 오픈/답장/반송 여부를 한 줄로 보여줌.

import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Eye, Reply, AlertOctagon, Mail, Clock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Skeleton } from '@/components/ui/skeleton'
import { useContactSendHistory } from '@/hooks/useContactSendHistory'
import { cn } from '@/lib/utils'

interface Props {
  contactId: string | null | undefined
  /** 표시 개수 — 더 보기 버튼은 캠페인 페이지 내비게이션으로 대신 */
  limit?: number
}

export function ContactSendHistory({ contactId, limit = 8 }: Props) {
  const navigate = useNavigate()
  const { data: history = [], isLoading } = useContactSendHistory(contactId)

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (history.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center">
        <Mail className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
        <p className="text-xs text-muted-foreground">아직 발송한 메일이 없습니다.</p>
      </div>
    )
  }

  const visible = history.slice(0, limit)
  const hidden = history.length - visible.length

  return (
    <div className="space-y-1.5">
      {visible.map((h) => (
        <button
          key={h.recipient_id}
          type="button"
          onClick={() => navigate(`/campaigns/${h.campaign_id}`)}
          className="w-full text-left rounded-md border bg-card hover:bg-muted/40 transition-colors p-2 flex items-start gap-2"
        >
          <Clock className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-medium truncate">{h.campaign_name}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                {h.sent_at ? format(new Date(h.sent_at), 'MM/dd HH:mm', { locale: ko }) : '—'}
              </span>
            </div>
            {h.campaign_subject && (
              <p className="text-[11px] text-muted-foreground truncate">
                {h.campaign_subject}
              </p>
            )}
            <div className="flex items-center gap-2 mt-1">
              <ResultBadge
                icon={Eye}
                active={h.opened}
                label={
                  h.opened ? `오픈 ${h.open_count > 1 ? h.open_count : ''}`.trim() : '미오픈'
                }
                tone={h.opened ? 'positive' : 'muted'}
              />
              <ResultBadge
                icon={Reply}
                active={h.replied}
                label={h.replied ? '답장' : '답장 없음'}
                tone={h.replied ? 'positive' : 'muted'}
              />
              {h.bounced && <ResultBadge icon={AlertOctagon} active label="반송" tone="critical" />}
            </div>
          </div>
        </button>
      ))}
      {hidden > 0 && (
        <p className="text-[11px] text-muted-foreground text-center pt-1">
          +{hidden}건 더 (캠페인 페이지에서 확인)
        </p>
      )}
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
