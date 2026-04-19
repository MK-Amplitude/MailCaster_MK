import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { SignatureFormDialog } from '@/components/signatures/SignatureFormDialog'
import { SignaturePreview } from '@/components/signatures/SignaturePreview'
import { useSignatures, useDeleteSignature, useUpdateSignature } from '@/hooks/useSignatures'
import { Plus, PenLine, Pencil, Trash2, Star } from 'lucide-react'
import type { Signature } from '@/types/signature'

export default function SignaturesPage() {
  const { data: signatures = [], isLoading } = useSignatures()
  const deleteSignature = useDeleteSignature()
  const updateSignature = useUpdateSignature()

  const [formOpen, setFormOpen] = useState(false)
  const [editSig, setEditSig] = useState<Signature | null>(null)
  const [deleteSig, setDeleteSig] = useState<Signature | null>(null)

  const openCreate = () => {
    setEditSig(null)
    setFormOpen(true)
  }

  const openEdit = (sig: Signature) => {
    setEditSig(sig)
    setFormOpen(true)
  }

  const handleSetDefault = async (sig: Signature) => {
    await updateSignature.mutateAsync({ id: sig.id, data: { is_default: true } })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">서명 관리</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {signatures.length}개의 서명
          </p>
        </div>
        <Button size="sm" onClick={openCreate} className="shrink-0">
          <Plus className="w-4 h-4 mr-1.5" />
          서명 추가
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-full" />
            ))}
          </div>
        ) : signatures.length === 0 ? (
          <EmptyState
            icon={PenLine}
            title="서명이 없습니다"
            description="이메일 하단에 자동으로 추가될 서명을 만들어보세요."
            action={{ label: '서명 추가', onClick: openCreate }}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {signatures.map((sig) => (
              <SignatureCard
                key={sig.id}
                signature={sig}
                onEdit={openEdit}
                onDelete={setDeleteSig}
                onSetDefault={handleSetDefault}
              />
            ))}
          </div>
        )}
      </div>

      <SignatureFormDialog
        open={formOpen}
        onOpenChange={(v) => { setFormOpen(v); if (!v) setEditSig(null) }}
        signature={editSig}
      />
      <ConfirmDialog
        open={!!deleteSig}
        onOpenChange={(v) => !v && setDeleteSig(null)}
        title="서명 삭제"
        description={`"${deleteSig?.name}" 서명을 삭제하시겠습니까?`}
        confirmLabel="삭제"
        variant="destructive"
        loading={deleteSignature.isPending}
        onConfirm={async () => {
          if (!deleteSig) return
          try {
            await deleteSignature.mutateAsync(deleteSig.id)
            setDeleteSig(null)
          } catch {
            // onError 에서 토스트 표시
          }
        }}
      />
    </div>
  )
}

function SignatureCard({
  signature,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  signature: Signature
  onEdit: (s: Signature) => void
  onDelete: (s: Signature) => void
  onSetDefault: (s: Signature) => void
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm">{signature.name}</h3>
            {signature.is_default && (
              <Badge variant="secondary" className="text-xs py-0 px-1.5">
                <Star className="w-2.5 h-2.5 mr-1 fill-current" />
                기본
              </Badge>
            )}
          </div>
          <div className="flex gap-1">
            {!signature.is_default && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="기본 서명으로 설정"
                onClick={() => onSetDefault(signature)}
              >
                <Star className="w-3.5 h-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEdit(signature)}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(signature)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* 미리보기 */}
        <div className="border rounded bg-white dark:bg-gray-950 overflow-hidden max-h-36">
          <SignaturePreview html={signature.html} />
        </div>
      </CardContent>
    </Card>
  )
}
