import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChevronDown, ChevronRight, Folder, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGroupCategories } from '@/hooks/useGroupCategories'
import { useGroups } from '@/hooks/useGroups'
import { useAddContactsToGroup } from '@/hooks/useContacts'

interface AddToGroupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactIds: string[]
  onDone?: () => void
}

const UNCATEGORIZED_ID = '__uncategorized__'

export function AddToGroupDialog({ open, onOpenChange, contactIds, onDone }: AddToGroupDialogProps) {
  const { data: categories = [] } = useGroupCategories()
  const { data: groups = [], isLoading } = useGroups()
  const addToGroup = useAddContactsToGroup()

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleCategory = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // 카테고리별로 그룹 묶기 (미분류 섹션 포함)
  const tree = useMemo(() => {
    const byCategory = new Map<string, typeof groups>()
    for (const g of groups) {
      const key = g.category_id ?? UNCATEGORIZED_ID
      if (!byCategory.has(key)) byCategory.set(key, [])
      byCategory.get(key)!.push(g)
    }
    const nodes = categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      color: cat.color,
      groups: byCategory.get(cat.id) ?? [],
    }))
    const uncategorized = byCategory.get(UNCATEGORIZED_ID)
    if (uncategorized && uncategorized.length > 0) {
      nodes.push({ id: UNCATEGORIZED_ID, name: '미분류', color: '#6b7280', groups: uncategorized })
    }
    return nodes
  }, [categories, groups])

  const handleClose = () => {
    onOpenChange(false)
    setSelectedGroupId(null)
  }

  const handleConfirm = async () => {
    if (!selectedGroupId || contactIds.length === 0) return
    await addToGroup.mutateAsync({ contactIds, groupId: selectedGroupId })
    onDone?.()
    handleClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : handleClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>그룹에 추가</DialogTitle>
          <p className="text-sm text-muted-foreground">
            선택한 연락처 {contactIds.length}명을 추가할 그룹을 선택하세요.
          </p>
        </DialogHeader>

        <ScrollArea className="h-[360px] border rounded-md">
          <div className="p-1.5">
            {isLoading ? (
              <div className="p-4 text-sm text-center text-muted-foreground">로딩 중...</div>
            ) : tree.length === 0 ? (
              <div className="p-4 text-sm text-center text-muted-foreground">
                그룹이 없습니다. 먼저 그룹을 만들어주세요.
              </div>
            ) : (
              tree.map((cat) => {
                const isOpen = expanded.has(cat.id)
                return (
                  <div key={cat.id} className="mb-0.5">
                    <button
                      type="button"
                      onClick={() => toggleCategory(cat.id)}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-accent text-sm"
                    >
                      {isOpen ? (
                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                      <Folder
                        className="w-3.5 h-3.5"
                        style={{ color: cat.color ?? '#6b7280' }}
                      />
                      <span className="font-medium">{cat.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {cat.groups.length}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="ml-5 border-l pl-2 py-0.5">
                        {cat.groups.length === 0 ? (
                          <div className="px-2 py-1 text-xs text-muted-foreground">
                            그룹 없음
                          </div>
                        ) : (
                          cat.groups.map((g) => {
                            const active = selectedGroupId === g.id
                            return (
                              <button
                                key={g.id}
                                type="button"
                                onClick={() => setSelectedGroupId(g.id)}
                                className={cn(
                                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left',
                                  active
                                    ? 'bg-primary text-primary-foreground'
                                    : 'hover:bg-accent'
                                )}
                              >
                                <div
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: g.color ?? '#6b7280' }}
                                />
                                <span className="truncate">{g.name}</span>
                                <span
                                  className={cn(
                                    'ml-auto flex items-center gap-1 text-xs shrink-0',
                                    active ? 'text-primary-foreground/80' : 'text-muted-foreground'
                                  )}
                                >
                                  <Users className="w-3 h-3" />
                                  {g.member_count ?? 0}
                                </span>
                              </button>
                            )
                          })
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={addToGroup.isPending}>
            취소
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!selectedGroupId || addToGroup.isPending}
          >
            {addToGroup.isPending ? '추가 중...' : '추가'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
