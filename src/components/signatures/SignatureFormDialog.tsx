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
import { Switch } from '@/components/ui/switch'
import TipTapEditor from './TipTapEditor'
import { SignaturePreview } from './SignaturePreview'
import { useCreateSignature, useUpdateSignature } from '@/hooks/useSignatures'
import type { Signature } from '@/types/signature'

interface SignatureFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  signature?: Signature | null
}

export function SignatureFormDialog({ open, onOpenChange, signature }: SignatureFormDialogProps) {
  const isEdit = !!signature
  const create = useCreateSignature()
  const update = useUpdateSignature()

  const [name, setName] = useState('')
  const [html, setHtml] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [activeTab, setActiveTab] = useState<'visual' | 'html'>('visual')

  useEffect(() => {
    if (open) {
      setName(signature?.name ?? '')
      setHtml(signature?.html ?? '')
      setIsDefault(signature?.is_default ?? false)
      setActiveTab('visual')
    }
  }, [open, signature])

  // HTML 탭으로 전환 시 TipTap HTML 동기화
  const handleTabChange = (tab: string) => {
    setActiveTab(tab as 'visual' | 'html')
  }

  const handleSave = async () => {
    if (!name.trim()) return
    if (isEdit && signature) {
      await update.mutateAsync({ id: signature.id, data: { name: name.trim(), html, is_default: isDefault } })
    } else {
      await create.mutateAsync({ name: name.trim(), html, is_default: isDefault })
    }
    onOpenChange(false)
  }

  const isPending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? '서명 수정' : '서명 추가'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="sig-name">서명 이름</Label>
              <Input
                id="sig-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="기본 서명"
              />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch
                id="sig-default"
                checked={isDefault}
                onCheckedChange={setIsDefault}
              />
              <Label htmlFor="sig-default" className="text-sm">기본값</Label>
            </div>
          </div>

          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="h-8">
              <TabsTrigger value="visual" className="text-xs h-7">
                비주얼 에디터
              </TabsTrigger>
              <TabsTrigger value="html" className="text-xs h-7">
                HTML 편집
              </TabsTrigger>
              <TabsTrigger value="preview" className="text-xs h-7">
                미리보기
              </TabsTrigger>
            </TabsList>

            <TabsContent value="visual" className="mt-3">
              <TipTapEditor
                value={html}
                onChange={setHtml}
                placeholder="서명 내용을 입력하세요..."
              />
            </TabsContent>

            <TabsContent value="html" className="mt-3">
              <Textarea
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                className="font-mono text-xs min-h-[200px] resize-none"
                placeholder="<p>서명 HTML을 직접 입력하세요</p>"
              />
            </TabsContent>

            <TabsContent value="preview" className="mt-3">
              <div className="border rounded-lg bg-white dark:bg-gray-950 min-h-[160px]">
                <div className="p-3 border-b bg-muted/30">
                  <p className="text-xs text-muted-foreground">-- 이 아래로 서명이 표시됩니다 --</p>
                </div>
                <SignaturePreview html={html} />
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            취소
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || isPending}>
            {isPending ? '저장 중...' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
