// 캠페인 상세에 표시되는 "팔로업/회신/전달 기록" 섹션.
// 캠페인 발송 후 사용자가 ⋯ 메뉴로 보낸 1:1 후속 메일들의 리스트.
//
// 행 단위 표시:
//   - mode 배지 (팔로업/회신/전달)
//   - 받는 사람
//   - 제목
//   - 발송 시각
//   - 상태 + 오픈 추적 요약 (👁 2회 등)
//   - 행 클릭 → 상세 모달
//
// 비어 있으면 컴포넌트 자체가 렌더링 안 됨 (캠페인 상세 페이지 공간 절약).

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  useThreadMessagesByCampaign,
  type ThreadMessageRow,
  type ThreadMessageReply,
} from '@/hooks/useThreadMessages'
import { ThreadMessageDetailDialog } from './ThreadMessageDetailDialog'
import { ThreadComposeDialog } from './ThreadComposeDialog'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import {
  Reply,
  ReplyAll,
  Forward,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Clock,
  MessageCircle,
  AlertTriangle,
} from 'lucide-react'

interface Props {
  campaignId: string
}

const MODE_META = {
  followup: { label: '팔로업', Icon: Reply, badgeClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  reply: { label: '회신', Icon: ReplyAll, badgeClass: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
  forward: { label: '전달', Icon: Forward, badgeClass: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
} as const

const STATUS_META = {
  pending: { Icon: Clock, color: 'text-amber-600 dark:text-amber-400', label: '발송 중' },
  sent: { Icon: CheckCircle2, color: 'text-green-600 dark:text-green-400', label: '성공' },
  failed: { Icon: XCircle, color: 'text-red-600 dark:text-red-400', label: '실패' },
} as const

export function ThreadMessagesSection({ campaignId }: Props) {
  const { data: messages = [], isLoading } = useThreadMessagesByCampaign(campaignId)
  const [selected, setSelected] = useState<ThreadMessageRow | null>(null)
  // 받은 회신에 "회신하기" 클릭 시 → ThreadComposeDialog 를 reply 모드로 열기 위한 상태
  const [replyCompose, setReplyCompose] = useState<{
    parentMessage: ThreadMessageRow
    reply: ThreadMessageReply
  } | null>(null)

  const handleReplyToReceived = (reply: ThreadMessageReply) => {
    if (!selected) return
    setReplyCompose({ parentMessage: selected, reply })
    setSelected(null) // 상세 모달 닫고 작성 다이얼로그로 전환
  }

  if (isLoading) return null
  if (messages.length === 0) return null

  // 통계 — 헤더에 표시
  const totalCount = messages.length
  const openedCount = messages.filter((m) => m.opened).length
  const sentCount = messages.filter((m) => m.status === 'sent').length
  const repliedCount = messages.filter((m) => m.replied).length
  const bouncedCount = messages.filter((m) => m.bounced).length

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Reply className="w-4 h-4" />
            <span>팔로업 / 회신 / 전달 기록</span>
            <Badge variant="secondary" className="ml-1">
              {totalCount}건
            </Badge>
            <span className="text-xs text-muted-foreground font-normal ml-2">
              성공 {sentCount} · 오픈 {openedCount} · 회신 {repliedCount}
              {bouncedCount > 0 && (
                <span className="text-orange-600 dark:text-orange-400"> · 반송 {bouncedCount}</span>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground bg-muted/30 sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 font-medium w-20">유형</th>
                  <th className="text-left px-4 py-2 font-medium">받는 사람</th>
                  <th className="text-left px-4 py-2 font-medium">제목</th>
                  <th className="text-left px-4 py-2 font-medium w-32">발송 시각</th>
                  <th className="text-left px-4 py-2 font-medium w-24">상태</th>
                  <th className="text-left px-4 py-2 font-medium w-28">수신확인</th>
                  <th className="text-left px-4 py-2 font-medium w-24">회신</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => {
                  const modeMeta = MODE_META[m.mode]
                  const statusMeta = STATUS_META[m.status]
                  const ModeIcon = modeMeta.Icon
                  const StatusIcon = statusMeta.Icon
                  return (
                    <tr
                      key={m.id}
                      className="border-t hover:bg-muted/50 cursor-pointer transition-colors"
                      onClick={() => setSelected(m)}
                    >
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${modeMeta.badgeClass}`}
                        >
                          <ModeIcon className="w-3 h-3" />
                          {modeMeta.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 truncate max-w-[200px]">
                        {m.to_name ? (
                          <span>
                            <span className="font-medium">{m.to_name}</span>{' '}
                            <span className="text-muted-foreground text-xs">
                              &lt;{m.to_email}&gt;
                            </span>
                          </span>
                        ) : (
                          m.to_email
                        )}
                      </td>
                      <td className="px-4 py-2 truncate max-w-[280px]">
                        {m.subject || (
                          <span className="text-muted-foreground italic">(제목 없음)</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                        {m.sent_at
                          ? format(new Date(m.sent_at), 'M월 d일 HH:mm', { locale: ko })
                          : '-'}
                      </td>
                      <td className={`px-4 py-2 ${m.bounced ? 'text-orange-600 dark:text-orange-400' : statusMeta.color}`}>
                        <span
                          className="inline-flex items-center gap-1"
                          title={m.bounced && m.bounce_reason ? m.bounce_reason : undefined}
                        >
                          {m.bounced ? (
                            <>
                              <AlertTriangle className="w-3.5 h-3.5" />
                              반송
                            </>
                          ) : (
                            <>
                              <StatusIcon className="w-3.5 h-3.5" />
                              {statusMeta.label}
                            </>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {/* bounce 된 메일은 추적 데이터가 의미 없음 (메일이 안 갔으니) */}
                        {m.bounced ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title="반송된 메일 — 추적 데이터 의미 없음"
                          >
                            —
                          </span>
                        ) : m.opened ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <Eye className="w-3.5 h-3.5" />
                            <span className="text-xs font-medium">{m.open_count}회</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <EyeOff className="w-3.5 h-3.5" />
                            <span className="text-xs">-</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {m.bounced ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title="반송된 메일 — 추적 데이터 의미 없음"
                          >
                            —
                          </span>
                        ) : m.replied ? (
                          <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                            <MessageCircle className="w-3.5 h-3.5" />
                            <span className="text-xs font-medium">{m.reply_count}건</span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <ThreadMessageDetailDialog
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        message={selected}
        onReplyClick={handleReplyToReceived}
      />

      {/* 받은 회신에 다시 회신할 때 — 같은 thread 안에서 reply 모드.
          key 로 reply.id 를 지정 — 다른 회신에 다시 "회신하기" 클릭 시 ThreadComposeDialog 의
          useEffect deps 에 reply.id 가 없어도 React 가 강제 remount → 새 본문/인용으로 reset. */}
      {replyCompose && (
        <ThreadComposeDialog
          key={replyCompose.reply.id}
          open={!!replyCompose}
          onOpenChange={(o) => !o && setReplyCompose(null)}
          mode="reply"
          original={{
            // 같은 thread 유지 — 회신은 부모 thread_message 의 thread 안에 계속 쌓임
            gmailThreadId: replyCompose.parentMessage.gmail_thread_id,
            // In-Reply-To 헤더 — 받은 회신 메시지의 RFC Message-ID 직접 사용 (있으면 fetch 스킵).
            // record_thread_reply RPC 가 rfc_message_id 를 채워두므로 대부분 비어있지 않음.
            gmailMessageId: replyCompose.reply.gmail_message_id,
            rfcMessageId: replyCompose.reply.rfc_message_id,
            subject: replyCompose.reply.subject ?? replyCompose.parentMessage.subject,
            // 인용 본문 — body_text 를 HTML 로 감싸서 처리 (개행 보존)
            bodyHtml: replyCompose.reply.body_text
              ? `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(replyCompose.reply.body_text)}</pre>`
              : null,
            fromLabel: formatFromLabel(replyCompose.reply),
            sentAt: replyCompose.reply.received_at,
          }}
          recipient={{
            // 회신을 보낸 사람에게 회신하는 거니, From → To
            email: replyCompose.reply.from_email ?? '',
            name: replyCompose.reply.from_name,
            contactId: replyCompose.parentMessage.contact_id,
            recipientId: replyCompose.parentMessage.recipient_id,
            campaignId: replyCompose.parentMessage.campaign_id,
          }}
        />
      )}
    </>
  )
}

// "이름 <email>" 형식. 둘 다 없으면 "발신자"
function formatFromLabel(reply: ThreadMessageReply): string {
  if (reply.from_name && reply.from_email) return `${reply.from_name} <${reply.from_email}>`
  if (reply.from_email) return reply.from_email
  return reply.from_name ?? '발신자'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
