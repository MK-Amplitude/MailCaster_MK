import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import TipTapEditor from '@/components/signatures/TipTapEditor'
import { SignaturePreview } from '@/components/signatures/SignaturePreview'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AttachmentSection } from '@/components/attachments/AttachmentSection'
import { useCreateTemplate, useUpdateTemplate } from '@/hooks/useTemplates'
import { useTemplateAttachments } from '@/hooks/useAttachments'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import type { Template } from '@/types/template'
import { TEMPLATE_VARIABLES } from '@/types/template'
import { extractVariables } from '@/lib/mailMerge'
import { Braces } from 'lucide-react'
import type { Database } from '@/types/database.types'

type DriveAttachmentRow = Database['mailcaster']['Tables']['drive_attachments']['Row']

interface TemplateFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  template?: Template | null
}

export function TemplateFormDialog({ open, onOpenChange, template }: TemplateFormDialogProps) {
  const isEdit = !!template
  const create = useCreateTemplate()
  const update = useUpdateTemplate()

  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [bodyHtml, setBodyHtml] = useState('')
  const [tab, setTab] = useState<'visual' | 'html' | 'preview'>('visual')
  const [attachments, setAttachments] = useState<DriveAttachmentRow[]>([])
  const [initialAttachmentIds, setInitialAttachmentIds] = useState<string[]>([])
  const [savingAttachments, setSavingAttachments] = useState(false)
  // S7: AttachmentSection 내부 upload/pick 진행 중인지 — 저장 버튼 비활성화에 사용
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)

  // 편집 모드: 기존 템플릿의 첨부 로드
  const { data: existingAttachments } = useTemplateAttachments(
    isEdit && open ? template?.id : undefined
  )

  useEffect(() => {
    if (open) {
      setName(template?.name ?? '')
      setSubject(template?.subject ?? '')
      setBodyHtml(template?.body_html ?? '')
      setTab('visual')
      // S6: 매번 열 때 첨부 초기화 — edit A → edit B 전환 시 A 의 첨부가 잔상으로 남는 걸 방지.
      //     edit 인 경우 아래의 existingAttachments effect 가 즉시 B 의 첨부로 채운다.
      setAttachments([])
      setInitialAttachmentIds([])
    }
  }, [open, template, isEdit])

  // existingAttachments 가 로드/변경되면 초기값으로 세팅
  useEffect(() => {
    if (open && isEdit && existingAttachments) {
      setAttachments(existingAttachments)
      setInitialAttachmentIds(existingAttachments.map((a) => a.id))
    }
  }, [open, isEdit, existingAttachments])

  // 제목 input 에 변수 삽입
  const insertVariableIntoSubject = (key: string) => {
    setSubject((s) => s + `{{${key}}}`)
  }
  // 본문에 변수 삽입 (HTML 소스 끝에 append — TipTap 은 다음 content 동기화 시 반영)
  const insertVariableIntoBody = (key: string) => {
    setBodyHtml((h) => `${h}{{${key}}}`)
  }

  /** 템플릿 저장 후 template_attachments 링크 동기화 (diff 방식) */
  async function syncTemplateAttachments(templateId: string) {
    const currentIds = attachments.map((a) => a.id)
    const toRemove = initialAttachmentIds.filter((id) => !currentIds.includes(id))
    const toAdd = currentIds.filter((id) => !initialAttachmentIds.includes(id))

    // 삭제
    if (toRemove.length > 0) {
      const { error } = await supabase
        .from('template_attachments')
        .delete()
        .eq('template_id', templateId)
        .in('attachment_id', toRemove)
      if (error) throw error
    }

    // 추가 (upsert — 중복 안전)
    if (toAdd.length > 0) {
      const rows = toAdd.map((attachment_id) => ({
        template_id: templateId,
        attachment_id,
        sort_order: currentIds.indexOf(attachment_id),
      }))
      const { error } = await supabase
        .from('template_attachments')
        .upsert(rows, { onConflict: 'template_id,attachment_id' })
      if (error) throw error
    }

    // sort_order 업데이트 — 순서가 바뀐 기존 항목도 반영
    const reorders = currentIds
      .filter((id) => initialAttachmentIds.includes(id))
      .map((attachment_id) => ({
        template_id: templateId,
        attachment_id,
        sort_order: currentIds.indexOf(attachment_id),
      }))
    if (reorders.length > 0) {
      const { error } = await supabase
        .from('template_attachments')
        .upsert(reorders, { onConflict: 'template_id,attachment_id' })
      if (error) throw error
    }
  }

  const handleSave = async () => {
    if (!name.trim() || !subject.trim()) return
    const variables = Array.from(
      new Set([...extractVariables(subject), ...extractVariables(bodyHtml)])
    )
    const payload = {
      name: name.trim(),
      subject: subject.trim(),
      body_html: bodyHtml,
      variables,
    }

    // 2단계 저장: (1) 템플릿 CRUD (hook 이 toast 처리) → (2) 첨부 링크 sync
    //   - 단계 1 실패: hook onError 가 이미 toast 표시 → 여기선 중복 toast 띄우지 않음
    //   - 단계 2 실패: 템플릿은 저장됐지만 첨부만 실패한 상태 → warning 으로 보완 표시
    setSavingAttachments(true)
    let templateId: string | null = null
    try {
      if (isEdit && template) {
        await update.mutateAsync({ id: template.id, data: payload })
        templateId = template.id
      } else {
        const created = await create.mutateAsync(payload)
        templateId = created.id
      }
    } catch (e) {
      // 템플릿 save 자체 실패 — hook onError 에서 이미 toast 처리됨
      console.error('[TemplateFormDialog] template save failed:', e)
      setSavingAttachments(false)
      return
    }

    try {
      await syncTemplateAttachments(templateId!)
      onOpenChange(false)
    } catch (e) {
      console.error('[TemplateFormDialog] attachment sync failed:', e)
      toast.warning(
        `템플릿은 저장됐지만 첨부 파일 동기화에 실패했습니다: ${
          e instanceof Error ? e.message : '알 수 없는 오류'
        }`
      )
      // 다이얼로그는 닫지 않음 — 사용자가 재시도 가능하게
    } finally {
      setSavingAttachments(false)
    }
  }

  const isPending = create.isPending || update.isPending || savingAttachments
  // 업로드/Drive pick 이 진행 중이면 저장 버튼도 비활성 — 부분 첨부로 저장되는 것 방지
  const saveDisabled = !name.trim() || !subject.trim() || isPending || attachmentsBusy

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? '템플릿 수정' : '템플릿 추가'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>템플릿 이름</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 뉴스레터 3월호"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>메일 제목</Label>
              <VariableDropdown onInsert={insertVariableIntoSubject} />
            </div>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="안녕하세요 {{name}}님"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>본문</Label>
              <VariableDropdown onInsert={insertVariableIntoBody} />
            </div>
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList className="h-8">
                <TabsTrigger value="visual" className="text-xs h-7">
                  비주얼
                </TabsTrigger>
                <TabsTrigger value="html" className="text-xs h-7">
                  HTML
                </TabsTrigger>
                <TabsTrigger value="preview" className="text-xs h-7">
                  미리보기
                </TabsTrigger>
              </TabsList>

              <TabsContent value="visual" className="mt-2">
                <TipTapEditor
                  value={bodyHtml}
                  onChange={setBodyHtml}
                  placeholder="메일 본문 작성..."
                />
              </TabsContent>
              <TabsContent value="html" className="mt-2">
                <Textarea
                  value={bodyHtml}
                  onChange={(e) => setBodyHtml(e.target.value)}
                  className="font-mono text-xs min-h-[240px] resize-y"
                  placeholder="<p>안녕하세요 {{name}}님</p>"
                />
              </TabsContent>
              <TabsContent value="preview" className="mt-2">
                <div className="border rounded-lg bg-white dark:bg-gray-950 min-h-[200px]">
                  <SignaturePreview html={bodyHtml} />
                </div>
              </TabsContent>
            </Tabs>
            <p className="text-xs text-muted-foreground">
              변수 예시: <code className="bg-muted px-1 py-0.5 rounded">{`{{name}}`}</code>{' '}
              <code className="bg-muted px-1 py-0.5 rounded">{`{{company}}`}</code>
            </p>
          </div>

          <AttachmentSection
            attachments={attachments}
            onChange={setAttachments}
            onBusyChange={setAttachmentsBusy}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            취소
          </Button>
          <Button onClick={handleSave} disabled={saveDisabled}>
            {isPending ? '저장 중...' : attachmentsBusy ? '첨부 처리 중...' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function VariableDropdown({ onInsert }: { onInsert: (key: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs">
          <Braces className="w-3.5 h-3.5 mr-1" />
          변수 삽입
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {TEMPLATE_VARIABLES.map((v) => (
          <DropdownMenuItem
            key={v.key}
            onClick={() => onInsert(v.key)}
            className="text-xs"
          >
            <span className="font-medium">{`{{${v.key}}}`}</span>
            <span className="ml-auto text-muted-foreground">{v.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
