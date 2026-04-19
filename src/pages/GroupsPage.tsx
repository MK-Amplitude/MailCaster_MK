import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { CategoryList } from '@/components/groups/CategoryList'
import { GroupFormDialog } from '@/components/groups/GroupFormDialog'
import { GroupMembersSheet } from '@/components/groups/GroupMembersSheet'
import { useGroups, useDeleteGroup } from '@/hooks/useGroups'
import type { Group } from '@/types/group'
import { Plus, Users, MoreHorizontal, Pencil, Trash2, FolderOpen } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export default function GroupsPage() {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editGroup, setEditGroup] = useState<Group | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Group | null>(null)
  const [membersGroup, setMembersGroup] = useState<Group | null>(null)
  const [membersOpen, setMembersOpen] = useState(false)

  type GroupWithCat = Group & { group_categories: { id: string; name: string; color: string | null; icon: string | null } | null }
  const { data: groups = [] as GroupWithCat[], isLoading } = useGroups(selectedCategoryId ?? undefined)
  const deleteGroup = useDeleteGroup()

  const openCreate = () => {
    setEditGroup(null)
    setFormOpen(true)
  }

  const openEdit = (group: Group) => {
    setEditGroup(group)
    setFormOpen(true)
  }

  const openMembers = (group: Group) => {
    setMembersGroup(group)
    setMembersOpen(true)
  }

  return (
    <div className="flex h-full">
      {/* 좌측 카테고리 사이드바 */}
      <div className="w-56 border-r shrink-0 hidden sm:flex flex-col">
        <CategoryList
          selectedCategoryId={selectedCategoryId}
          onSelectCategory={setSelectedCategoryId}
        />
      </div>

      {/* 우측 그룹 목록 */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">그룹</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {groups.length}개 그룹
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4 mr-1.5" />
            그룹 추가
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {!isLoading && groups.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="그룹이 없습니다"
              description="그룹을 만들어 연락처를 체계적으로 관리하세요."
              action={{ label: '그룹 추가', onClick: openCreate }}
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {groups.map((group) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  onEdit={openEdit}
                  onDelete={setDeleteTarget}
                  onOpenMembers={openMembers}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 다이얼로그 / 시트 */}
      <GroupFormDialog
        open={formOpen}
        onOpenChange={(v) => { setFormOpen(v); if (!v) setEditGroup(null) }}
        group={editGroup}
        defaultCategoryId={selectedCategoryId}
      />
      <GroupMembersSheet
        group={membersGroup}
        open={membersOpen}
        onOpenChange={setMembersOpen}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="그룹 삭제"
        description={`"${deleteTarget?.name}" 그룹을 삭제하시겠습니까? 연락처는 삭제되지 않습니다.`}
        confirmLabel="삭제"
        variant="destructive"
        loading={deleteGroup.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await deleteGroup.mutateAsync(deleteTarget.id)
            setDeleteTarget(null)
          } catch {
            // 에러는 훅의 onError 에서 토스트로 표시됨
          }
        }}
      />
    </div>
  )
}

function GroupCard({
  group,
  onEdit,
  onDelete,
  onOpenMembers,
}: {
  group: Group & { group_categories?: { name: string; color: string | null } | null }
  onEdit: (g: Group) => void
  onDelete: (g: Group) => void
  onOpenMembers: (g: Group) => void
}) {
  const cat = (group as { group_categories?: { name: string; color: string | null } | null }).group_categories

  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => onOpenMembers(group)}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm truncate">{group.name}</h3>
            {cat && (
              <Badge
                variant="outline"
                className="text-xs mt-1 py-0 px-1.5"
                style={cat.color ? { borderColor: cat.color, color: cat.color } : undefined}
              >
                {cat.name}
              </Badge>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(group) }}>
                <Pencil className="w-4 h-4 mr-2" /> 수정
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); onDelete(group) }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" /> 삭제
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Users className="w-3.5 h-3.5" />
          <span className="text-sm">{group.member_count}명</span>
        </div>

        {group.description && (
          <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
            {group.description}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
