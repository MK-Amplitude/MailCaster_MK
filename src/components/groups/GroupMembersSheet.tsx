import { useEffect, useMemo, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  useGroupMembers,
  useAddMemberToGroup,
  useRemoveMemberFromGroup,
  useRemoveMembersFromGroup,
} from '@/hooks/useGroups'
import { useContacts } from '@/hooks/useContacts'
import { matchesSearch } from '@/lib/search'
import { UserPlus, Trash2, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Group } from '@/types/group'

interface GroupMembersSheetProps {
  group: Group | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface Member {
  id: string
  email: string
  name: string | null
  company: string | null
  department: string | null
  job_title: string | null
  is_unsubscribed: boolean
  is_bounced: boolean
}

const PAGE_SIZE = 20

export function GroupMembersSheet({ group, open, onOpenChange }: GroupMembersSheetProps) {
  const { data: membersRaw = [], isLoading } = useGroupMembers(group?.id ?? '')
  const { data: allContacts = [] } = useContacts()
  const addMember = useAddMemberToGroup()
  const removeMember = useRemoveMemberFromGroup()
  const removeMembers = useRemoveMembersFromGroup()

  const members = membersRaw as unknown as Member[]

  const [search, setSearch] = useState('')
  const [memberFilter, setMemberFilter] = useState('')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  // 시트 닫히거나 그룹 바뀌면 초기화
  useEffect(() => {
    if (!open) {
      setSearch('')
      setMemberFilter('')
      setPage(1)
      setSelectedIds(new Set())
    }
  }, [open])

  useEffect(() => {
    setPage(1)
    setSelectedIds(new Set())
  }, [group?.id])

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members])

  // 상단 "추가" 검색 — 전체 연락처 대상
  const searchResults = useMemo(() => {
    const q = search.trim()
    if (!q) return []
    return allContacts
      .filter(
        (c) =>
          matchesSearch(c.name, q) ||
          matchesSearch(c.email, q) ||
          matchesSearch(c.company, q) ||
          matchesSearch(c.department, q) ||
          matchesSearch(c.job_title, q)
      )
      .slice(0, 20)
  }, [allContacts, search])

  // 멤버 목록 필터 — 그룹 내에서 검색
  const filteredMembers = useMemo(() => {
    const q = memberFilter.trim()
    if (!q) return members
    return members.filter(
      (m) =>
        matchesSearch(m.name, q) ||
        matchesSearch(m.email, q) ||
        matchesSearch(m.company, q) ||
        matchesSearch(m.department, q) ||
        matchesSearch(m.job_title, q)
    )
  }, [members, memberFilter])

  const totalPages = Math.max(1, Math.ceil(filteredMembers.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagedMembers = useMemo(
    () => filteredMembers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredMembers, safePage]
  )

  const pageIds = useMemo(() => pagedMembers.map((m) => m.id), [pagedMembers])
  const filteredIds = useMemo(() => filteredMembers.map((m) => m.id), [filteredMembers])

  const selectedCount = selectedIds.size
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))
  const somePageSelected = pageIds.some((id) => selectedIds.has(id))
  const pageCheckboxState: boolean | 'indeterminate' =
    allPageSelected ? true : somePageSelected ? 'indeterminate' : false

  const togglePageSelect = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) pageIds.forEach((id) => next.add(id))
      else pageIds.forEach((id) => next.delete(id))
      return next
    })
  }

  const selectAllFiltered = () => setSelectedIds(new Set(filteredIds))
  const clearSelection = () => setSelectedIds(new Set())

  const toggleOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const handleAdd = async (contactId: string) => {
    if (!group) return
    await addMember.mutateAsync({ contactId, groupId: group.id })
    setSearch('')
  }

  const handleRemove = async (contactId: string) => {
    if (!group) return
    await removeMember.mutateAsync({ contactId, groupId: group.id })
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(contactId)
      return next
    })
  }

  const handleBulkDelete = async () => {
    if (!group || selectedIds.size === 0) return
    await removeMembers.mutateAsync({
      contactIds: [...selectedIds],
      groupId: group.id,
    })
    setSelectedIds(new Set())
    setBulkDeleteOpen(false)
  }

  if (!group) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-5 py-4 border-b">
          <SheetTitle className="text-left">
            <div>
              <span className="text-base font-semibold">{group.name}</span>
              <p className="text-sm text-muted-foreground font-normal mt-0.5">
                멤버 {group.member_count}명
              </p>
            </div>
          </SheetTitle>
        </SheetHeader>

        {/* 멤버 추가 검색 */}
        <div className="px-4 py-3 border-b space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="연락처 검색 후 추가 (이름/이메일/회사/부서/직책, 초성 가능)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {search.trim() && (
            <div className="border rounded-lg bg-popover shadow-sm divide-y max-h-48 overflow-y-auto">
              {searchResults.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground text-center">
                  검색 결과가 없습니다.
                </div>
              ) : (
                searchResults.map((contact) => {
                  const alreadyMember = memberIds.has(contact.id)
                  return (
                    <div
                      key={contact.id}
                      className="flex items-center justify-between px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {contact.name ?? contact.email}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {contact.email}
                          {contact.company ? ` · ${contact.company}` : ''}
                          {contact.job_title ? ` · ${contact.job_title}` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={alreadyMember ? 'outline' : 'default'}
                        className="h-7 text-xs shrink-0 ml-2"
                        disabled={alreadyMember || addMember.isPending}
                        onClick={() => handleAdd(contact.id)}
                      >
                        {alreadyMember ? '추가됨' : '추가'}
                      </Button>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* 멤버 내 필터 + 벌크 액션 바 */}
        {members.length > 0 && (
          <div className="px-4 py-2 border-b space-y-2 bg-muted/20">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                className="pl-7 h-7 text-xs"
                placeholder="멤버 내 검색"
                value={memberFilter}
                onChange={(e) => {
                  setMemberFilter(e.target.value)
                  setPage(1)
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={pageCheckboxState}
                  onCheckedChange={(v) => togglePageSelect(!!v)}
                />
                <span className="text-muted-foreground">
                  {selectedCount > 0
                    ? `${selectedCount}명 선택됨`
                    : `페이지 선택 (${pageIds.length}명)`}
                </span>
                {selectedCount > 0 && selectedCount < filteredMembers.length && (
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={selectAllFiltered}
                  >
                    전체 {filteredMembers.length}명 선택
                  </button>
                )}
                {selectedCount > 0 && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:underline"
                    onClick={clearSelection}
                  >
                    해제
                  </button>
                )}
              </div>
              {selectedCount > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  onClick={() => setBulkDeleteOpen(true)}
                  disabled={removeMembers.isPending}
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  제외
                </Button>
              )}
            </div>
          </div>
        )}

        {/* 멤버 목록 */}
        <ScrollArea className="flex-1">
          <div className="divide-y">
            {isLoading ? (
              <div className="p-4 space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : members.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-6">
                <UserPlus className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  아직 멤버가 없습니다. 위에서 연락처를 검색하여 추가하세요.
                </p>
              </div>
            ) : filteredMembers.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                검색 결과가 없습니다.
              </div>
            ) : (
              pagedMembers.map((m) => {
                const checked = selectedIds.has(m.id)
                return (
                  <div
                    key={m.id}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => toggleOne(m.id, !!v)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">
                          {m.name ?? '이름 없음'}
                        </span>
                        <StatusBadge
                          isUnsubscribed={m.is_unsubscribed}
                          isBounced={m.is_bounced}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {m.email}
                        {m.company ? ` · ${m.company}` : ''}
                        {m.job_title ? ` · ${m.job_title}` : ''}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemove(m.id)}
                      disabled={removeMember.isPending}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>

        {/* 페이지네이션 */}
        {filteredMembers.length > PAGE_SIZE && (
          <div className="px-4 py-2 border-t flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {(safePage - 1) * PAGE_SIZE + 1}-
              {Math.min(safePage * PAGE_SIZE, filteredMembers.length)} /{' '}
              {filteredMembers.length}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </Button>
              <span className="px-2 min-w-[40px] text-center">
                {safePage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}

        <ConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title={`멤버 ${selectedCount}명 제외`}
          description="선택한 멤버를 그룹에서 제외합니다. 연락처 자체는 삭제되지 않습니다."
          confirmLabel="제외"
          variant="destructive"
          loading={removeMembers.isPending}
          onConfirm={handleBulkDelete}
        />
      </SheetContent>
    </Sheet>
  )
}
