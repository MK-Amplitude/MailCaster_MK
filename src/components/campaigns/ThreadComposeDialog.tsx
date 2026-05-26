// 팔로업 / 회신 / 전달 통합 작성 다이얼로그.
//
// 진입점:
//   - 캠페인 detail page 의 수신자 행에서 액션 메뉴
//   - 연락처 timeline 의 메일 행
//   - (추후) 캠페인 전체 답장 안 한 사람들 일괄
//
// 모드별 동작:
//   followup — 원본 수신자에게 같은 thread 안에 다시 발송. To = 원본 To.
//   reply    — 고객 답장에 thread 안 답장. To = 답장한 사람 (= 원본 수신자).
//   forward  — 새 thread, To = 사용자가 선택 (contact 검색).
//
// 본문 인용:
//   reply / forward 는 원본 HTML 을 quoted block 으로 자동 첨부.
//   사용자가 본문 위쪽에 작성하고, 아래 quote 는 접혀있거나 그대로.

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Reply, ReplyAll, Forward, Loader2, Search } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import TipTapEditor from '@/components/signatures/TipTapEditor'
import { useSignatures } from '@/hooks/useSignatures'
import { useSendThreadMessage, type ThreadMode } from '@/hooks/useSendThreadMessage'
import { useContacts } from '@/hooks/useContacts'
import { matchesSearch } from '@/lib/search'

interface OriginalMessage {
  /** Gmail 내부 message id (recipients.gmail_message_id 또는 답장 메시지 id). */
  gmailMessageId: string | null
  /**
   * 원본 메시지의 RFC 2822 Message-ID. 있으면 fetchMessageRfcId 호출 스킵 (Gmail API quota 절감).
   * thread_message_replies.rfc_message_id 가 이미 저장돼 있으면 그대로 전달.
   */
  rfcMessageId?: string | null
  /** Gmail thread id — followup/reply 는 이 thread 에 끼움. */
  gmailThreadId: string | null
  subject: string | null
  /** 원본 본문 HTML — 인용 블록으로 사용. NULL 이면 인용 생략. */
  bodyHtml?: string | null
  /** 원본 발신자 이름/이메일 — 인용 헤더 ("On ... wrote:") 에 사용 */
  fromLabel?: string | null
  /** 원본 발송 시각 ISO */
  sentAt?: string | null
}

interface OriginalRecipient {
  contactId?: string | null
  recipientId?: string | null
  campaignId?: string | null
  email: string
  name?: string | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ThreadMode
  /** 원본 메시지 — subject prefix / In-Reply-To / 본문 인용에 사용 */
  original: OriginalMessage
  /** 원본 수신자 정보 — followup/reply 의 To 기본값 */
  recipient: OriginalRecipient
}

export function ThreadComposeDialog({
  open,
  onOpenChange,
  mode,
  original,
  recipient,
}: Props) {
  const send = useSendThreadMessage()
  const { data: signatures = [] } = useSignatures()
  const defaultSig = useMemo(
    () => signatures.find((s) => s.is_default) ?? signatures[0] ?? null,
    [signatures],
  )

  // mode → 제목 prefix
  const subjectPrefix = mode === 'forward' ? 'Fwd: ' : 'Re: '
  const initialSubject = (() => {
    const base = original.subject ?? ''
    if (!base) return subjectPrefix
    // 이미 Re:/Fwd: 시작이면 중복 prefix 방지
    if (/^(Re|RE|Fwd|FW|FWD):/i.test(base)) return base
    return `${subjectPrefix}${base}`
  })()

  // 본문 초기값 — 사용자 영역 (빈 div) + 시그니처 + 원본 인용 블록.
  // followup 도 인용 포함: 발송자가 "내가 뭐 보냈더라" 를 보면서 쓸 수 있어야 하고,
  // Gmail 답장 UX 와도 일관 (Gmail 은 같은 thread 안에서 인용을 자동 collapse).
  // 사용자가 원하면 편집기에서 인용 블록을 지우고 보낼 수 있음.
  const initialBody = (() => {
    const sigPart = defaultSig?.html ? `<br/><br/>${defaultSig.html}` : ''
    const quote = original.bodyHtml ? buildQuoteBlock(original) : ''
    return `<p></p>${sigPart}${quote}`
  })()

  // 폼 state
  const [subject, setSubject] = useState(initialSubject)
  const [body, setBody] = useState(initialBody)
  const [toEmail, setToEmail] = useState(recipient.email)
  const [toName, setToName] = useState(recipient.name ?? '')

  // dialog 가 새로 열릴 때 (또는 mode/recipient 바뀔 때) 초기값으로 reset.
  useEffect(() => {
    if (!open) return
    setSubject(initialSubject)
    setBody(initialBody)
    setToEmail(recipient.email)
    setToName(recipient.name ?? '')
  // initialSubject / initialBody 는 매 렌더 새로 계산되므로 deps 에서 제외 — open 만 핵심.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, recipient.email])

  // forward 모드의 To 변경용 — 연락처 검색 + 직접 입력
  const [toPickerOpen, setToPickerOpen] = useState(false)
  const [toSearch, setToSearch] = useState('')

  const { data: allContacts = [] } = useContacts({
    scope: 'org',
    status: 'normal',
    sort: { field: 'name', dir: 'asc' },
  })
  const candidateContacts = useMemo(() => {
    const q = toSearch.trim()
    return allContacts
      .filter(
        (c) =>
          !q ||
          matchesSearch(c.name, q) ||
          matchesSearch(c.email, q) ||
          matchesSearch(c.company, q),
      )
      .slice(0, 30)
  }, [allContacts, toSearch])

  const handleSend = async () => {
    // try/finally — Gmail 발송 후 DB 단계에서 throw 가 나도 다이얼로그는 반드시 닫음.
    // 그렇지 않으면 사용자가 같은 본문을 다시 클릭해 중복 발송 위험 (8차 감사 C1).
    // 에러 토스트는 useSendThreadMessage 의 onError 가 처리.
    try {
      await send.mutateAsync({
        mode,
        toEmail,
        toName,
        subject,
        html: body,
        // followup / reply: 같은 thread 안에 들어가야 함. forward: 새 thread.
        threadId: mode === 'forward' ? null : original.gmailThreadId,
        // followup 도 In-Reply-To 헤더 넣어 Gmail 이 "답장 chain" 으로 인식하게 함.
        // (Gmail 은 threadId 만으로도 묶지만, 표준 헤더를 같이 보내는 게 모든 클라이언트 호환)
        inReplyToGmailMessageId:
          mode === 'forward' ? null : original.gmailMessageId,
        // 이미 알고 있는 RFC Message-ID (thread_message_replies.rfc_message_id 등) — fetch 스킵용
        inReplyToRfcMessageId:
          mode === 'forward' ? null : original.rfcMessageId ?? null,
        campaignId: recipient.campaignId,
        recipientId: recipient.recipientId,
        contactId: recipient.contactId,
      })
    } finally {
      onOpenChange(false)
    }
  }

  const modeMeta = getModeMeta(mode)
  const Icon = modeMeta.icon

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="w-4 h-4" />
            {modeMeta.title}
            <Badge variant="secondary" className="text-[10px] font-normal">
              {modeMeta.modeLabel}
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {modeMeta.description}
            {' '}{original.gmailThreadId && mode !== 'forward' && (
              <span className="text-emerald-700 dark:text-emerald-400">
                · Gmail thread 안 메시지로 전송됩니다.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 받는 사람 — forward 만 변경 가능 */}
          <div className="space-y-1.5">
            <Label htmlFor="thread-to" className="text-xs">받는 사람</Label>
            {mode === 'forward' ? (
              <div className="flex items-center gap-2">
                <Input
                  id="thread-to"
                  type="email"
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                  placeholder="example@company.com"
                  className="h-8 text-sm"
                />
                <Popover open={toPickerOpen} onOpenChange={setToPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" size="sm" className="h-8 shrink-0">
                      <Search className="w-3.5 h-3.5 mr-1" />
                      연락처 검색
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-2" align="end">
                    <Input
                      autoFocus
                      placeholder="이름/이메일/회사 검색"
                      value={toSearch}
                      onChange={(e) => setToSearch(e.target.value)}
                      className="h-8 text-sm mb-2"
                    />
                    <div className="max-h-64 overflow-y-auto">
                      {candidateContacts.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-3 text-center">
                          {toSearch.trim() ? '결과 없음' : '검색어를 입력하세요'}
                        </p>
                      ) : (
                        <ul className="space-y-0.5">
                          {candidateContacts.map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setToEmail(c.email)
                                  setToName(c.name ?? '')
                                  setToPickerOpen(false)
                                  setToSearch('')
                                }}
                                className="w-full text-left px-2 py-1.5 rounded hover:bg-accent flex items-baseline gap-2"
                              >
                                <span className="text-sm truncate font-medium">
                                  {c.name ?? c.email}
                                </span>
                                <span className="text-xs text-muted-foreground truncate flex-1">
                                  {c.email}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            ) : (
              <div className="text-sm flex items-center gap-2 px-3 py-1.5 rounded bg-muted/40">
                {recipient.name && <span className="font-medium">{recipient.name}</span>}
                <span className="text-muted-foreground">&lt;{recipient.email}&gt;</span>
              </div>
            )}
          </div>

          {/* 제목 */}
          <div className="space-y-1.5">
            <Label htmlFor="thread-subject" className="text-xs">제목</Label>
            <Input
              id="thread-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* 서명 선택 — 기본 서명 자동 적용, 변경하려면 select */}
          {signatures.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">서명</Label>
              <Select
                value={defaultSig?.id ?? ''}
                onValueChange={(sigId) => {
                  // 본문 끝의 기존 서명 (defaultSig) 을 선택된 서명으로 교체.
                  // 단순 정책 — defaultSig.html 부분을 replace. 없으면 append.
                  const sig = signatures.find((s) => s.id === sigId)
                  if (!sig) return
                  setBody((prev) => {
                    if (defaultSig?.html && prev.includes(defaultSig.html)) {
                      return prev.replace(defaultSig.html, sig.html)
                    }
                    return `${prev}<br/><br/>${sig.html}`
                  })
                }}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="서명 선택" />
                </SelectTrigger>
                <SelectContent>
                  {signatures.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      {s.is_default && (
                        <span className="text-[10px] text-muted-foreground ml-1">
                          (기본)
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* 본문 — TipTap */}
          <div className="space-y-1.5">
            <Label className="text-xs">본문</Label>
            <TipTapEditor value={body} onChange={setBody} placeholder="본문을 입력하세요" />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={send.isPending}
          >
            취소
          </Button>
          <Button type="button" onClick={handleSend} disabled={send.isPending}>
            {send.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                발송 중...
              </>
            ) : (
              <>
                <Icon className="w-4 h-4 mr-1.5" />
                {modeMeta.sendLabel}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function getModeMeta(mode: ThreadMode) {
  switch (mode) {
    case 'followup':
      return {
        icon: Reply,
        title: '팔로업 메일 작성',
        modeLabel: 'Follow-up',
        description: '같은 thread 안에 다시 메일을 보냅니다 — 받는 사람에게는 연속 대화로 보입니다.',
        sendLabel: '팔로업 발송',
      }
    case 'reply':
      return {
        icon: ReplyAll,
        title: '회신 메일 작성',
        modeLabel: 'Reply',
        description: '받은 메일에 같은 thread 로 답장합니다.',
        sendLabel: '회신 발송',
      }
    case 'forward':
      return {
        icon: Forward,
        title: '메일 전달',
        modeLabel: 'Forward',
        description: '이 메일을 다른 사람에게 전달합니다 — 새 thread 가 시작됩니다.',
        sendLabel: '전달',
      }
  }
}

/**
 * Gmail-style 인용 블록 — reply/forward 시 원본 본문 아래에 붙임.
 * 디자인: 왼쪽 회색 선 + "On ... wrote:" 헤더.
 */
function buildQuoteBlock(original: OriginalMessage): string {
  const fromLabel = original.fromLabel ?? '발신자'
  const dateLabel = original.sentAt
    ? new Date(original.sentAt).toLocaleString('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  const header = `${dateLabel}, ${fromLabel} 님이 작성:`
  return `<br/><br/><div style="border-left: 3px solid #ccc; padding-left: 12px; color: #555;"><div style="font-size: 12px; color: #888; margin-bottom: 6px;">${header}</div>${original.bodyHtml ?? ''}</div>`
}
