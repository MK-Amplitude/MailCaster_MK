// Contact 한 명의 메일 히스토리 — outbound (thread_messages) + inbound (inbound_messages) 통합.
//
// 표시:
//   - 시간 역순 (최근 위)
//   - 각 행: 방향 아이콘 (↗ 보냄 / ↙ 받음), 시각, 제목, snippet/본문 일부
//   - 받은 메일 (inbound) 옆에 "회신" 버튼 → ThreadComposeDialog reply 모드
//   - 행 클릭: 본문 모달 (또는 inline 확장)

import { useState } from 'react'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ArrowDownLeft, ArrowUpRight, Mail, MessageCircle, AlertTriangle, Eye, EyeOff } from 'lucide-react'
import {
  useContactMailHistory,
  type MailHistoryItem,
  type InboundMessage,
} from '@/hooks/useContactMailHistory'
import { ThreadComposeDialog } from '@/components/campaigns/ThreadComposeDialog'
import { escapeHtml } from '@/lib/utils'

interface Props {
  contactId: string
  contactName?: string | null
}

export function ContactMailHistory({ contactId, contactName }: Props) {
  const { data: items = [], isLoading } = useContactMailHistory(contactId)
  // 받은 메일에 "회신" 클릭 시 ThreadComposeDialog 를 reply 모드로 열기
  const [replyTo, setReplyTo] = useState<InboundMessage | null>(null)

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">메일 히스토리 로딩 중...</div>
  }
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        주고받은 메일이 없습니다. Gmail 에 새 메일이 도착하면 5분 이내 자동 표시됩니다.
      </div>
    )
  }

  return (
    <>
      <div className="space-y-2">
        {items.map((it, idx) => {
          const itemId =
            it.kind === 'campaign' ? it.row.recipient.id : it.row.id
          return (
            <MailHistoryRow
              key={`${it.kind}-${itemId}-${idx}`}
              item={it}
              onReplyClick={(inb) => setReplyTo(inb)}
            />
          )
        })}
      </div>

      {replyTo && (
        <ThreadComposeDialog
          key={replyTo.id}
          open={!!replyTo}
          onOpenChange={(o) => !o && setReplyTo(null)}
          mode="reply"
          original={{
            gmailThreadId: replyTo.gmail_thread_id,
            gmailMessageId: replyTo.gmail_message_id,
            rfcMessageId: replyTo.rfc_message_id,
            subject: replyTo.subject,
            // 인용 본문 — 외부 발신자 HTML 은 XSS 위험이라 절대 raw 로 렌더하지 않음.
            // body_text (또는 snippet) 만 escape 해서 안전하게 표시. body_html fallback 제거.
            bodyHtml: `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(
              replyTo.body_text || replyTo.snippet || '',
            )}</pre>`,
            fromLabel: formatFromLabel(replyTo),
            sentAt: replyTo.received_at,
          }}
          recipient={{
            email: replyTo.from_email,
            name: replyTo.from_name ?? contactName ?? null,
            contactId: contactId,
            recipientId: null,
            campaignId: null,
          }}
        />
      )}
    </>
  )
}

function MailHistoryRow({
  item,
  onReplyClick,
}: {
  item: MailHistoryItem
  onReplyClick: (inb: InboundMessage) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const ts = format(new Date(item.ts), 'M월 d일 HH:mm', { locale: ko })

  if (item.kind === 'outbound') {
    const m = item.row
    const modeLabelKr =
      m.mode === 'followup'
        ? '팔로업'
        : m.mode === 'reply'
          ? '회신'
          : m.mode === 'forward'
            ? '전달'
            : '새 메일'
    return (
      <div className="border rounded-lg p-3 bg-blue-50/40 dark:bg-blue-950/20">
        <div className="flex items-start gap-2">
          <ArrowUpRight className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">{ts}</span>
              <Badge variant="secondary" className="text-xs">
                {modeLabelKr}
              </Badge>
              {m.bounced && (
                <span className="inline-flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400">
                  <AlertTriangle className="w-3 h-3" />
                  반송
                </span>
              )}
              {/* 오픈 추적 — bounce 가 아니면 항상 표시 (1통이든 다수든 일관) */}
              {!m.bounced && (
                <OpenBadge opened={m.opened} openCount={m.open_count} />
              )}
              {!m.bounced && m.replied && (
                <span className="inline-flex items-center gap-1 text-xs text-cyan-600 dark:text-cyan-400">
                  <MessageCircle className="w-3 h-3" />
                  회신 {m.reply_count}
                </span>
              )}
            </div>
            <div className="font-medium text-sm mt-0.5 truncate">
              {m.subject || '(제목 없음)'}
            </div>
            {m.body_html && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-xs text-muted-foreground mt-1 hover:text-foreground"
              >
                {expanded ? '본문 접기' : '본문 보기'}
              </button>
            )}
            {expanded && m.body_html && (
              <div
                className="prose prose-sm max-w-none dark:prose-invert mt-2 border-t pt-2"
                dangerouslySetInnerHTML={{ __html: m.body_html }}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  // campaign — 캠페인 본 발송 (recipients) — outbound 색조 유지하되 별도 라벨
  if (item.kind === 'campaign') {
    const r = item.row.recipient
    const subject = item.row.campaignSubject
    const bodyHtml = item.row.campaignBodyHtml
    return (
      <div className="border rounded-lg p-3 bg-blue-50/40 dark:bg-blue-950/20">
        <div className="flex items-start gap-2">
          <ArrowUpRight className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">{ts}</span>
              <Badge variant="secondary" className="text-xs">
                캠페인 발송
              </Badge>
              {r.bounced && (
                <span className="inline-flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400">
                  <AlertTriangle className="w-3 h-3" />
                  반송
                </span>
              )}
              {/* 캠페인 발송도 오픈 추적 동일하게 표시 */}
              {!r.bounced && (
                <OpenBadge opened={r.opened} openCount={r.open_count} />
              )}
              {!r.bounced && r.replied && (
                <span className="inline-flex items-center gap-1 text-xs text-cyan-600 dark:text-cyan-400">
                  <MessageCircle className="w-3 h-3" />
                  회신함
                </span>
              )}
            </div>
            <div className="font-medium text-sm mt-0.5 truncate">
              {subject || '(제목 없음)'}
            </div>
            {bodyHtml && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-xs text-muted-foreground mt-1 hover:text-foreground"
              >
                {expanded ? '본문 접기' : '본문 보기'}
              </button>
            )}
            {expanded && bodyHtml && (
              <div
                className="prose prose-sm max-w-none dark:prose-invert mt-2 border-t pt-2"
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  // inbound
  const m = item.row
  return (
    <div className="border rounded-lg p-3 bg-emerald-50/40 dark:bg-emerald-950/20">
      <div className="flex items-start gap-2">
        <ArrowDownLeft className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">{ts}</span>
            <span className="text-xs text-muted-foreground">
              {m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email}
            </span>
          </div>
          <div className="font-medium text-sm mt-0.5 truncate">
            {m.subject || '(제목 없음)'}
          </div>
          {(m.body_text || m.snippet) && (
            <>
              <div className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">
                {m.body_text || m.snippet}
              </div>
              {(m.body_text || m.body_html) && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="text-xs text-muted-foreground mt-1 hover:text-foreground"
                >
                  {expanded ? '본문 접기' : '본문 보기'}
                </button>
              )}
            </>
          )}
          {expanded && (
            <div className="border-t pt-2 mt-2 text-sm whitespace-pre-wrap break-words">
              {m.body_text || '(본문 없음)'}
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onReplyClick(m)}
          className="shrink-0"
        >
          <Mail className="w-3.5 h-3.5 mr-1" />
          회신
        </Button>
      </div>
    </div>
  )
}

function formatFromLabel(reply: InboundMessage): string {
  if (reply.from_name && reply.from_email) return `${reply.from_name} <${reply.from_email}>`
  return reply.from_email
}

/** 발송된 메일의 오픈 추적 표시 — 1통이든 다수든 일관된 형태. 보내진 모든 메일에 사용. */
function OpenBadge({ opened, openCount }: { opened: boolean; openCount: number }) {
  if (opened) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
        title={`총 ${openCount}회 열어봤습니다`}
      >
        <Eye className="w-3 h-3" />
        {openCount}회
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      title="아직 열어보지 않았습니다"
    >
      <EyeOff className="w-3 h-3" />
      미오픈
    </span>
  )
}
