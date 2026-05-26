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
} from '@/hooks/useThreadMessages'
import { ThreadMessageDetailDialog } from './ThreadMessageDetailDialog'
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

  if (isLoading) return null
  if (messages.length === 0) return null

  // 통계 — 헤더에 표시
  const totalCount = messages.length
  const openedCount = messages.filter((m) => m.opened).length
  const sentCount = messages.filter((m) => m.status === 'sent').length

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
              성공 {sentCount} · 오픈 {openedCount}
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
                      <td className={`px-4 py-2 ${statusMeta.color}`}>
                        <span className="inline-flex items-center gap-1">
                          <StatusIcon className="w-3.5 h-3.5" />
                          {statusMeta.label}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {m.opened ? (
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
      />
    </>
  )
}
