// AI 개인화 발송 — 사람마다 살짝 다른 본문을 LLM 으로 생성, 검토/수정 후 캠페인 생성.
//
// 흐름:
//   Step 1: intent (의도) + tone 입력 → "AI 생성" 클릭
//   Step 2: LLM 생성 (loading)
//   Step 3: 사람별 카드 (subject + body 인라인 편집)
//   Step 4: "캠페인 만들기" → 캠페인 + recipients(overrides) 저장 → 캠페인 페이지로 이동
//
// 한 번에 최대 50명 (edge function 제한). 그 이상은 나눠서 호출.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Sparkles, Loader2, RotateCcw, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useSignatures } from '@/hooks/useSignatures'
import {
  useGeneratePersonalizedBodies,
  useCreatePersonalizedCampaign,
  type GeneratedBody,
} from '@/hooks/usePersonalizedSend'

interface SelectedContact {
  id: string
  name: string | null
  email: string
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  contacts: SelectedContact[]
}

const TONE_OPTIONS: Array<{ value: 'formal' | 'friendly' | 'concise'; label: string }> = [
  { value: 'friendly', label: '친근하고 자연스럽게' },
  { value: 'formal', label: '정중하고 격식 있게' },
  { value: 'concise', label: '간결하고 본질만' },
]

export function PersonalizedSendDialog({ open, onOpenChange, contacts }: Props) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { data: signatures = [] } = useSignatures()
  const generate = useGeneratePersonalizedBodies()
  const create = useCreatePersonalizedCampaign()

  // 사용자의 기본 서명을 LLM 본문 끝에 붙여 일관성 유지.
  // is_default 가 없으면 최신 서명을 fallback 으로.
  const defaultSignatureHtml = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = signatures as any[]
    const def = list.find((s) => s.is_default) ?? list[0]
    return (def?.html as string | undefined) ?? undefined
  }, [signatures])

  const [intent, setIntent] = useState('')
  const [tone, setTone] = useState<'formal' | 'friendly' | 'concise'>('friendly')
  const [drafts, setDrafts] = useState<Record<string, { subject: string; body: string }>>({})
  const [creating, setCreating] = useState(false)

  // dialog 닫힐 때 초기화 — 다음 열림 때 깨끗한 상태
  useEffect(() => {
    if (!open) {
      setIntent('')
      setTone('friendly')
      setDrafts({})
    }
  }, [open])

  const senderName = useMemo(() => {
    return (
      (user?.user_metadata?.full_name as string) ??
      (user?.user_metadata?.name as string) ??
      undefined
    )
  }, [user])

  const hasResults = Object.keys(drafts).length > 0

  const handleGenerate = async () => {
    if (!intent.trim()) {
      toast.error('어떤 메일을 보낼지 짧게 적어주세요.')
      return
    }
    try {
      const results = await generate.mutateAsync({
        contactIds: contacts.map((c) => c.id),
        intent: intent.trim(),
        tone,
        senderName,
        signatureHtml: defaultSignatureHtml,
      })
      const next: Record<string, { subject: string; body: string }> = {}
      for (const r of results) {
        next[r.contact_id] = {
          subject: r.subject,
          body: htmlToText(r.body_html),
        }
      }
      setDrafts(next)
      toast.success(`${results.length}명 본문 생성 완료`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI 생성 실패')
    }
  }

  const handleRegenerateOne = async (contactId: string) => {
    const c = contacts.find((x) => x.id === contactId)
    if (!c) return
    try {
      const results = await generate.mutateAsync({
        contactIds: [contactId],
        intent: intent.trim(),
        tone,
        senderName,
        signatureHtml: defaultSignatureHtml,
      })
      if (results[0]) {
        setDrafts((prev) => ({
          ...prev,
          [contactId]: {
            subject: results[0].subject,
            body: htmlToText(results[0].body_html),
          },
        }))
        toast.success(`${c.name ?? c.email} 다시 생성됨`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '재생성 실패')
    }
  }

  const handleCreate = async () => {
    if (!hasResults) return
    const validBodies: GeneratedBody[] = []
    for (const c of contacts) {
      const d = drafts[c.id]
      if (!d) continue
      const subject = d.subject.trim() || '안녕하세요'
      const body = d.body.trim()
      if (!body) {
        toast.error(`${c.name ?? c.email}: 본문이 비어있습니다.`)
        return
      }
      validBodies.push({
        contact_id: c.id,
        name: c.name,
        email: c.email,
        subject,
        body_html: textToHtml(body),
      })
    }
    if (validBodies.length === 0) return

    setCreating(true)
    try {
      const campaignName = `AI 개인화 — ${intent.trim().slice(0, 40)}${intent.trim().length > 40 ? '…' : ''}`
      const r = await create.mutateAsync({ name: campaignName, bodies: validBodies })
      toast.success('초안이 생성됐습니다. 캠페인 페이지에서 발송하세요.')
      onOpenChange(false)
      navigate(`/campaigns/${r.campaign_id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '캠페인 생성 실패')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-primary" />
            AI 개인화 발송 ({contacts.length}명)
          </DialogTitle>
          <DialogDescription>
            사람별 컨텍스트 (이름·회사·마지막 활동·답장 톤)를 LLM 이 반영해 살짝 다른 본문을 만듭니다.
            검토하고 수정한 뒤 발송하세요.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-6 px-6 space-y-4">
          {/* intent + tone */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ai-intent">어떤 메일?</Label>
              <Textarea
                id="ai-intent"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="예: 6개월간 연락 못 드린 분들께 안부 인사 + 신제품 데모 제안 의향 살짝 비치기"
                rows={2}
                className="resize-none"
                disabled={generate.isPending}
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="space-y-1.5 flex-1">
                <Label className="text-xs">톤</Label>
                <Select value={tone} onValueChange={(v) => setTone(v as typeof tone)} disabled={generate.isPending}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TONE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                onClick={handleGenerate}
                disabled={generate.isPending || !intent.trim()}
                className="h-8 mt-5"
              >
                {generate.isPending ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />생성 중…</>
                ) : (
                  <><Sparkles className="w-3.5 h-3.5 mr-1.5" />{hasResults ? '전체 다시 생성' : 'AI 생성'}</>
                )}
              </Button>
            </div>
          </div>

          {/* 결과 — 사람별 카드 */}
          {hasResults && (
            <div className="space-y-3 pt-1">
              <p className="text-xs text-muted-foreground">
                각 카드를 직접 수정할 수 있습니다. 마음에 안 드는 사람만 우측 상단의 ⟳ 로 다시 생성.
              </p>
              {contacts.map((c) => {
                const d = drafts[c.id]
                if (!d) return null
                const isRegenerating = generate.isPending
                return (
                  <div key={c.id} className="rounded-lg border bg-card p-3 space-y-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{c.name ?? c.email}</div>
                        <div className="text-[11px] text-muted-foreground truncate">{c.email}</div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 shrink-0"
                        onClick={() => handleRegenerateOne(c.id)}
                        disabled={isRegenerating}
                        title="이 사람만 다시 생성"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px]">제목</Label>
                      <Input
                        value={d.subject}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [c.id]: { ...prev[c.id], subject: e.target.value },
                          }))
                        }
                        className="h-7 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px]">본문</Label>
                      <Textarea
                        value={d.body}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [c.id]: { ...prev[c.id], body: e.target.value },
                          }))
                        }
                        rows={6}
                        className="text-sm resize-y"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            취소
          </Button>
          {hasResults && (
            <Button type="button" onClick={handleCreate} disabled={creating}>
              {creating ? (
                <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />저장 중…</>
              ) : (
                '초안 만들기 → 캠페인 페이지로'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// HTML ↔ plain text — 인라인 편집을 위한 단순 변환.
// 1) HTML → text: 태그를 제거하고 <br> 을 \n 으로, </p> 다음을 \n\n 으로.
// 2) text → HTML: <p>...<br>...</p> 단락 분리.
function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<\/?p[^>]*>/gi, '')
    .replace(/<br\s*\/?>(?:\s*)/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}
