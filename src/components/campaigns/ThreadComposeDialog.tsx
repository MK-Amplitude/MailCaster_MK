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

import { useEffect, useMemo, useRef, useState } from 'react'
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
import { Reply, ReplyAll, Forward, Loader2, Search, Mail, Paperclip, X } from 'lucide-react'
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

  // mode → 제목 prefix.
  //   new      : prefix 없음, 사용자가 직접 입력
  //   forward  : Fwd:
  //   followup / reply : Re:
  const subjectPrefix = mode === 'new' ? '' : mode === 'forward' ? 'Fwd: ' : 'Re: '
  const initialSubject = (() => {
    if (mode === 'new') return original.subject ?? ''
    const base = original.subject ?? ''
    if (!base) return subjectPrefix
    if (/^(Re|RE|Fwd|FW|FWD):/i.test(base)) return base
    return `${subjectPrefix}${base}`
  })()

  // 본문 초기값 — 사용자가 작성하는 영역만 (빈 본문 + 시그니처).
  // 인용 블록은 본문 외부 collapse 패널로 분리 (E1) → 시그니처가 본문과 인용에 동시에 보이는 중복 문제 해결.
  // 발송 시 includeQuote=true 면 본문 끝에 인용을 합쳐 전송.
  const initialBody = (() => {
    const sigPart = defaultSig?.html ? `<br/><br/>${defaultSig.html}` : ''
    return `<p></p>${sigPart}`
  })()

  // 발송 시 본문에 합쳐질 인용 블록 (defaults: 있으면 포함)
  const quoteBlock = useMemo(
    () => (original.bodyHtml ? buildQuoteBlock(original) : ''),
    [original],
  )

  // 폼 state
  const [subject, setSubject] = useState(initialSubject)
  const [body, setBody] = useState(initialBody)
  const [toEmail, setToEmail] = useState(recipient.email)
  const [toName, setToName] = useState(recipient.name ?? '')
  // 인용 포함 여부 — 기본 true. 사용자가 끌 수 있음.
  const [includeQuote, setIncludeQuote] = useState<boolean>(true)
  // 미리보기 모드 — 발송 직전 최종 모습 (본문 + 인용) read-only 표시
  const [showPreview, setShowPreview] = useState(false)
  // 첨부 파일 (로컬). Gmail 메시지 한도(~25MB) 고려해 합계 20MB 가드.
  const [attachments, setAttachments] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const totalAttachBytes = useMemo(
    () => attachments.reduce((sum, f) => sum + f.size, 0),
    [attachments],
  )
  const attachOversize = totalAttachBytes > MAX_ATTACH_BYTES

  // dialog 가 새로 열릴 때 (또는 mode/recipient 바뀔 때) 초기값으로 reset.
  useEffect(() => {
    if (!open) return
    setSubject(initialSubject)
    setBody(initialBody)
    setToEmail(recipient.email)
    setToName(recipient.name ?? '')
    setIncludeQuote(true)
    setShowPreview(false)
    setAttachments([])
  // initialSubject / initialBody 는 매 렌더 새로 계산되므로 deps 에서 제외 — open 만 핵심.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, recipient.email])

  // 발송될 최종 HTML — 본문 + (포함 여부에 따라) 인용 블록
  const finalBodyHtml = useMemo(() => {
    return includeQuote && quoteBlock ? `${body}${quoteBlock}` : body
  }, [body, includeQuote, quoteBlock])

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
        html: finalBodyHtml,
        // followup / reply: 같은 thread 안에 들어가야 함. forward: 새 thread.
        threadId: mode === 'forward' || mode === 'new' ? null : original.gmailThreadId,
        // followup 도 In-Reply-To 헤더 넣어 Gmail 이 "답장 chain" 으로 인식하게 함.
        // (Gmail 은 threadId 만으로도 묶지만, 표준 헤더를 같이 보내는 게 모든 클라이언트 호환)
        inReplyToGmailMessageId:
          mode === 'forward' || mode === 'new' ? null : original.gmailMessageId,
        // 이미 알고 있는 RFC Message-ID (thread_message_replies.rfc_message_id 등) — fetch 스킵용
        inReplyToRfcMessageId:
          mode === 'forward' || mode === 'new' ? null : original.rfcMessageId ?? null,
        campaignId: recipient.campaignId,
        recipientId: recipient.recipientId,
        contactId: recipient.contactId,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    } finally {
      onOpenChange(false)
    }
  }

  function handleFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    if (picked.length > 0) {
      // 이름+크기 기준 중복 제외하고 추가
      setAttachments((prev) => {
        const seen = new Set(prev.map((f) => `${f.name}:${f.size}`))
        return [...prev, ...picked.filter((f) => !seen.has(`${f.name}:${f.size}`))]
      })
    }
    // 같은 파일 재선택 가능하도록 input 초기화
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
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
          {/* 받는 사람 — forward / new 는 변경 가능 (Contact 검색 + 직접 입력) */}
          <div className="space-y-1.5">
            <Label htmlFor="thread-to" className="text-xs">받는 사람</Label>
            {mode === 'forward' || mode === 'new' ? (
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
                  // 본문 끝의 기존 서명 을 선택된 서명으로 교체.
                  // 정확한 정책 — TipTap 이 정규화한 HTML 매칭이 실패할 수 있으므로
                  // (a) 직접 HTML 매칭 시도, (b) plain-text fragment 매칭 시도, (c) append.
                  // 어느 케이스든 시그니처가 본문에 2개 들어가지 않음.
                  const sig = signatures.find((s) => s.id === sigId)
                  if (!sig) return
                  setBody((prev) => {
                    if (defaultSig?.html && prev.includes(defaultSig.html)) {
                      return prev.replace(defaultSig.html, sig.html)
                    }
                    // plain text fragment 로 위치 찾기 — TipTap 정규화로 HTML 이 달라져도 매칭
                    if (defaultSig?.html) {
                      const sigPlainFragment = defaultSig.html
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 60)
                      const prevPlain = prev.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                      if (sigPlainFragment && prevPlain.includes(sigPlainFragment)) {
                        // 이미 비슷한 시그니처가 본문에 있음 — 새로 append 안 함 (중복 방지).
                        // 사용자가 본문에서 시그니처를 수동 편집한 상황 → 그대로 둠.
                        return prev
                      }
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

          {/* 본문 — TipTap 또는 미리보기 토글 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">본문 {showPreview && <span className="text-muted-foreground">(미리보기 — 받는 사람이 볼 모습)</span>}</Label>
              <button
                type="button"
                onClick={() => setShowPreview((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPreview ? '편집으로 돌아가기' : '미리보기'}
              </button>
            </div>
            {showPreview ? (
              <div className="border rounded-md p-4 max-h-[400px] overflow-y-auto bg-white dark:bg-zinc-950">
                <div
                  className="prose prose-sm max-w-none dark:prose-invert"
                  // 발송될 최종 HTML 그대로 — 본문 + (포함 옵션 시) 인용 블록
                  dangerouslySetInnerHTML={{ __html: finalBodyHtml }}
                />
              </div>
            ) : (
              <TipTapEditor value={body} onChange={setBody} placeholder="본문을 입력하세요" />
            )}
          </div>

          {/* 첨부 파일 */}
          <div className="space-y-1.5">
            <Label className="text-xs">첨부 파일</Label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFilesPicked}
            />
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="w-3.5 h-3.5 mr-1" />
                파일 추가
              </Button>
            </div>
            {attachments.length > 0 && (
              <ul className="space-y-1">
                {attachments.map((f, i) => (
                  <li
                    key={`${f.name}:${f.size}:${i}`}
                    className="flex items-center gap-2 text-xs bg-muted/40 rounded px-2 py-1"
                  >
                    <Paperclip className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="truncate flex-1">{f.name}</span>
                    <span className="text-muted-foreground shrink-0">{formatBytes(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      aria-label="첨부 제거"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {attachOversize && (
              <p className="text-xs text-rose-600">
                첨부 합계가 20MB 를 초과했습니다 ({formatBytes(totalAttachBytes)}). 파일을 줄여주세요.
              </p>
            )}
          </div>

          {/* 이전 대화 인용 — 본문 외부의 collapse 패널 (Gmail 답장 UX 와 일관)
              - 시그니처가 본문과 인용에 동시 표시되던 중복 문제를 분리로 해결
              - 사용자가 "함께 보내기" 체크박스로 인용 포함 여부 토글 */}
          {original.bodyHtml && !showPreview && (
            <details className="border rounded-md group">
              <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground hover:text-foreground select-none flex items-center justify-between">
                <span>이전 대화 보기 {includeQuote ? '— 함께 발송됩니다' : '— 발송에서 제외됨'}</span>
                <span className="text-muted-foreground group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="border-t p-3 space-y-2">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={includeQuote}
                    onChange={(e) => setIncludeQuote(e.target.checked)}
                    className="rounded"
                  />
                  <span>받는 사람에게 인용 함께 보내기</span>
                </label>
                <div
                  className="prose prose-sm max-w-none dark:prose-invert max-h-60 overflow-y-auto text-muted-foreground"
                  // 읽기 전용 미리보기 — 편집은 불가 (이전 대화이므로 수정할 일 없음)
                  dangerouslySetInnerHTML={{ __html: original.bodyHtml ?? '' }}
                />
              </div>
            </details>
          )}
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
          <Button
            type="button"
            onClick={handleSend}
            disabled={send.isPending || !toEmail.trim() || attachOversize}
          >
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

// Gmail 메시지 한도(~25MB)를 고려한 첨부 합계 상한 (base64 인코딩 여유 포함 보수적 20MB).
const MAX_ATTACH_BYTES = 20 * 1024 * 1024

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
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
    case 'new':
      return {
        icon: Mail,
        title: '메일 작성',
        modeLabel: '새 메일',
        description: '새로운 1:1 메일을 작성합니다 — 받는 사람과의 새 대화가 시작됩니다.',
        sendLabel: '발송',
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
