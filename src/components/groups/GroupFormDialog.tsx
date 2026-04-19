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
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCreateGroup, useUpdateGroup } from '@/hooks/useGroups'
import { useGroupCategories } from '@/hooks/useGroupCategories'
import type { Group } from '@/types/group'

interface GroupFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  group?: Group | null
  defaultCategoryId?: string | null
}

export function GroupFormDialog({ open, onOpenChange, group, defaultCategoryId }: GroupFormDialogProps) {
  const isEdit = !!group
  const createGroup = useCreateGroup()
  const updateGroup = useUpdateGroup()
  const { data: categories = [] } = useGroupCategories()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<string>('')

  useEffect(() => {
    if (open) {
      setName(group?.name ?? '')
      setDescription(group?.description ?? '')
      setCategoryId(group?.category_id ?? defaultCategoryId ?? '')
    }
  }, [open, group, defaultCategoryId])

  const handleSave = async () => {
    if (!name.trim()) return
    if (isEdit && group) {
      await updateGroup.mutateAsync({
        id: group.id,
        data: { name: name.trim(), description: description.trim() || null, category_id: categoryId || null },
      })
    } else {
      await createGroup.mutateAsync({
        name: name.trim(),
        description: description.trim() || null,
        category_id: categoryId || null,
      })
    }
    onOpenChange(false)
  }

  const isPending = createGroup.isPending || updateGroup.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{isEdit ? '그룹 수정' : '그룹 추가'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>그룹명 *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="그룹명" />
          </div>
          <div className="space-y-1.5">
            <Label>카테고리</Label>
            <Select
              value={categoryId || '__none__'}
              onValueChange={(v) => setCategoryId(v === '__none__' ? '' : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="카테고리 없음" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— 없음 —</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: cat.color ?? '#6b7280' }}
                      />
                      {cat.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>설명</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="그룹 설명"
              rows={2}
              className="resize-none"
            />
          </div>
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
