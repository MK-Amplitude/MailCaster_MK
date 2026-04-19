import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { TemplateFormDialog } from '@/components/templates/TemplateFormDialog'
import { useTemplates, useDeleteTemplate } from '@/hooks/useTemplates'
import { matchesSearch } from '@/lib/search'
import { FileText, Plus, Pencil, Trash2, Search, Copy } from 'lucide-react'
import type { Template } from '@/types/template'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'

export default function TemplatesPage() {
  const { data: templates = [], isLoading } = useTemplates()
  const deleteTemplate = useDeleteTemplate()

  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editTemplate, setEditTemplate] = useState<Template | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim()
    if (!q) return templates
    return templates.filter(
      (t) => matchesSearch(t.name, q) || matchesSearch(t.subject, q)
    )
  }, [templates, search])

  const openCreate = () => {
    setEditTemplate(null)
    setFormOpen(true)
  }

  const openEdit = (t: Template) => {
    setEditTemplate(t)
    setFormOpen(true)
  }

  const openDuplicate = (t: Template) => {
    setEditTemplate({
      ...t,
      id: '',
      name: `${t.name} (복사본)`,
    } as Template)
    setFormOpen(true)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b">
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">템플릿</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {templates.length}개의 템플릿
            </p>
          </div>
          <Button size="sm" onClick={openCreate} className="shrink-0">
            <Plus className="w-4 h-4 sm:mr-1.5" />
            <span className="hidden sm:inline">템플릿 추가</span>
          </Button>
        </div>
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder="이름, 제목으로 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={search ? '검색 결과가 없습니다' : '템플릿이 없습니다'}
            description="자주 쓰는 메일 내용을 템플릿으로 저장하세요."
            action={search ? undefined : { label: '템플릿 추가', onClick: openCreate }}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                onEdit={openEdit}
                onDuplicate={openDuplicate}
                onDelete={setDeleteTarget}
              />
            ))}
          </div>
        )}
      </div>

      <TemplateFormDialog
        open={formOpen}
        onOpenChange={(v) => {
          setFormOpen(v)
          if (!v) setEditTemplate(null)
        }}
        template={editTemplate}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="템플릿 삭제"
        description={`"${deleteTarget?.name}" 템플릿을 삭제하시겠습니까?`}
        confirmLabel="삭제"
        variant="destructive"
        loading={deleteTemplate.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await deleteTemplate.mutateAsync(deleteTarget.id)
            setDeleteTarget(null)
          } catch {
            // onError 에서 토스트 표시
          }
        }}
      />
    </div>
  )
}

function TemplateCard({
  template,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  template: Template
  onEdit: (t: Template) => void
  onDuplicate: (t: Template) => void
  onDelete: (t: Template) => void
}) {
  const plainBody = template.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  return (
    <Card className="flex flex-col">
      <CardContent className="p-4 flex flex-col flex-1">
        <div className="flex items-start justify-between mb-2">
          <h3 className="font-semibold text-sm truncate flex-1 mr-2">{template.name}</h3>
          <div className="flex gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="복제"
              onClick={() => onDuplicate(template)}
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEdit(template)}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(template)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground truncate mb-2">{template.subject}</p>
        <p className="text-xs text-muted-foreground line-clamp-3 flex-1">{plainBody}</p>
        <div className="flex items-center justify-between mt-3 pt-3 border-t">
          <div className="flex gap-1 flex-wrap">
            {template.variables.slice(0, 3).map((v) => (
              <Badge key={v} variant="secondary" className="text-[10px] py-0 px-1.5">
                {`{{${v}}}`}
              </Badge>
            ))}
            {template.variables.length > 3 && (
              <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                +{template.variables.length - 3}
              </Badge>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
            {format(new Date(template.updated_at), 'M월 d일', { locale: ko })}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
