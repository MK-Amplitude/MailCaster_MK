import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  useGroupCategories,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
} from '@/hooks/useGroupCategories'
import { useAuth } from '@/hooks/useAuth'
import type { GroupCategory } from '@/types/group'
import { Plus, Pencil, Trash2, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const PRESET_COLORS = [
  '#3b82f6', '#22c55e', '#a855f7', '#6b7280',
  '#ef4444', '#f97316', '#eab308', '#06b6d4',
]

interface CategoryListProps {
  selectedCategoryId: string | null
  onSelectCategory: (id: string | null) => void
}

export function CategoryList({ selectedCategoryId, onSelectCategory }: CategoryListProps) {
  const { data: categories = [] } = useGroupCategories()
  const createCat = useCreateCategory()
  const updateCat = useUpdateCategory()
  const deleteCat = useDeleteCategory()
  const { user, isOrgAdmin } = useAuth()
  // RLS: group_categories_update/delete_own_or_admin — 오너 또는 org admin 만 편집
  const canMutate = (cat: GroupCategory) => cat.user_id === user?.id || isOrgAdmin

  const [formOpen, setFormOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<GroupCategory | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<GroupCategory | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])

  const openCreate = () => {
    setEditTarget(null)
    setName('')
    setColor(PRESET_COLORS[0])
    setFormOpen(true)
  }

  const openEdit = (cat: GroupCategory) => {
    setEditTarget(cat)
    setName(cat.name)
    setColor(cat.color ?? PRESET_COLORS[0])
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (!name.trim()) return
    if (editTarget) {
      await updateCat.mutateAsync({ id: editTarget.id, data: { name: name.trim(), color } })
    } else {
      await createCat.mutateAsync({ name: name.trim(), color })
    }
    setFormOpen(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h2 className="text-sm font-semibold">카테고리</h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={openCreate}>
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {/* 전체 보기 */}
        <button
          onClick={() => onSelectCategory(null)}
          className={cn(
            'w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors',
            selectedCategoryId === null
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-accent'
          )}
        >
          <ChevronRight className="w-3.5 h-3.5" />
          전체 그룹
        </button>

        {categories.map((cat) => (
          <div key={cat.id} className="group relative">
            <button
              onClick={() => onSelectCategory(cat.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors',
                selectedCategoryId === cat.id
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-foreground hover:bg-accent'
              )}
            >
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: cat.color ?? '#6b7280' }}
              />
              <span className="flex-1 text-left truncate">{cat.name}</span>
            </button>

            {/* 액션 버튼 — 오너/admin 에게만 노출 */}
            {canMutate(cat) && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); openEdit(cat) }}
                >
                  <Pencil className="w-3 h-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setDeleteTarget(cat) }}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 카테고리 생성/수정 다이얼로그 */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{editTarget ? '카테고리 수정' : '카테고리 추가'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>이름</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="카테고리명"
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              />
            </div>
            <div className="space-y-1.5">
              <Label>색상</Label>
              <div className="flex gap-2 flex-wrap">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={cn(
                      'w-7 h-7 rounded-full border-2 transition-transform',
                      color === c ? 'border-foreground scale-110' : 'border-transparent'
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>취소</Button>
            <Button
              onClick={handleSave}
              disabled={!name.trim() || createCat.isPending || updateCat.isPending}
            >
              저장
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="카테고리 삭제"
        description={`"${deleteTarget?.name}" 카테고리를 삭제하면 소속 그룹은 카테고리 없음 상태가 됩니다.`}
        confirmLabel="삭제"
        variant="destructive"
        loading={deleteCat.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await deleteCat.mutateAsync(deleteTarget.id)
            setDeleteTarget(null)
          } catch {
            // onError 에서 토스트 표시
          }
        }}
      />
    </div>
  )
}
