import { useEffect, useMemo, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  useGroupMembers,
  useAddMemberToGroup,
  useRemoveMemberFromGroup,
  useRemoveMembersFromGroup,
} from '@/hooks/useGroups'
import { useContacts, useAddContactsToGroup } from '@/hooks/useContacts'
import { matchesSearch } from '@/lib/search'
import { cn } from '@/lib/utils'
import { UserPlus, Trash2, Search, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { CUSTOMER_TYPE_OPTIONS, type CustomerType } from '@/types/contact'
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
  const addManyToGroup = useAddContactsToGroup()
  const removeMember = useRemoveMemberFromGroup()
  const removeMembers = useRemoveMembersFromGroup()

  const members = membersRaw as unknown as Member[]

  const [search, setSearch] = useState('')
  const [searchCustomerType, setSearchCustomerType] = useState<CustomerType | 'all'>('all')
  const [searchSelectedIds, setSearchSelectedIds] = useState<Set<string>>(new Set())
  const [memberFilter, setMemberFilter] = useState('')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  // 시트 닫히거나 그룹 바뀌면 초기화
  useEffect(() => {
    if (!open) {
      setSearch('')
      setSearchCustomerType('all')
      setSearchSelectedIds(new Set())
      setMemberFilter('')
      setPage(1)
      setSelectedIds(new Set())
    }
  }, [open])

  useEffect(() => {
    setPage(1)
    setSelectedIds(new Set())
    setSearchSelectedIds(new Set())
  }, [group?.id])

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members])

  // 상단 "추가" 검색 — 전체 연락처 대상.
  // 검색어가 비었어도 customer_type 필터만으로 결과를 보여줌 (예: 모든 Amplitude 고객 보기)
  const searchResults = useMemo(() => {
    const q = search.trim()
    const hasFilter = !!q || searchCustomerType !== 'all'
    if (!hasFilter) return []
    return allContacts
      .filter((c) => {
        if (searchCustomerType !== 'all' && c.customer_type !== searchCustomerType) return false
        if (!q) return true
        return (
          matchesSearch(c.name, q) ||
          matchesSearch(c.email, q) ||
          matchesSearch(c.company, q) ||
          matchesSearch(c.company_ko, q) ||
          matchesSearch(c.company_en, q) ||
          matchesSearch(c.department, q) ||
          matchesSearch(c.job_title, q)
        )
      })
      // 100명까지 노출 — 너무 많으면 사용자가 쥐고 가기 힘듦. 추가 결과는 검색 좁히도록 유도.
      .slice(0, 100)
  }, [allContacts, search, searchCustomerType])

  // 검색 결과 중 아직 멤버가 아닌 항목만 다중 선택/일괄 추가 대상.
  const addableSearchResults = useMemo(
    () => searchResults.filter((c) => !memberIds.has(c.id)),
    [searchResults, memberIds]
  )
  const addableSearchIds = useMemo(
    () => addableSearchResults.map((c) => c.id),
    [addableSearchResults]
  )
  const allSearchSelected =
    addableSearchIds.length > 0 && addableSearchIds.every((id) => searchSelectedIds.has(id))
  const someSearchSelected = addableSearchIds.some((id) => searchSelectedIds.has(id))
  const searchCheckboxState: boolean | 'indeterminate' = allSearchSelected
    ? true
    : someSearchSelected
    ? 'indeterminate'
    : false

  const toggleSearchSelect = (id: string, checked: boolean) => {
    setSearchSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const toggleSearchSelectAll = (checked: boolean) => {
    setSearchSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) addableSearchIds.forEach((id) => next.add(id))
      else addableSearchIds.forEach((id) => next.delete(id))
      return next
    })
  }

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
    // 검색 결과의 선택 상태에서도 제거 (이미 멤버가 됐으므로)
    setSearchSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(contactId)
      return next
    })
  }

  // 검색 결과 다중 선택 → 그룹에 일괄 추가
  const handleAddSelected = async () => {
    if (!group || searchSelectedIds.size === 0) return
    await addManyToGroup.mutateAsync({
      contactIds: [...searchSelectedIds],
      groupId: group.id,
    })
    setSearchSelectedIds(new Set())
    // 검색은 유지 — 사용자가 같은 검색에서 추가 작업을 이어가도록
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

        {/* 멤버 추가 검색 + 다중 선택 + 분류 필터 */}
        <div className="px-4 py-3 border-b space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-8 h-8 text-sm"
                placeholder="이름/이메일/회사/부서/직책 검색 (초성 가능)"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select
              value={searchCustomerType}
              onValueChange={(v) => setSearchCustomerType(v as CustomerType | 'all')}
            >
              <SelectTrigger className="h-8 w-28 text-xs shrink-0" title="고객 분류">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">분류 전체</SelectItem>
                {CUSTOMER_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(search.trim() || searchCustomerType !== 'all') && (
            <div className="border rounded-lg bg-popover shadow-sm overflow-hidden">
              {/* 검색 결과 헤더 — 전체 선택 + 일괄 추가 */}
              {addableSearchResults.length > 0 && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={searchCheckboxState}
                      onCheckedChange={(v) => toggleSearchSelectAll(!!v)}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      {searchSelectedIds.size > 0
                        ? `${searchSelectedIds.size}명 선택됨`
                        : `${addableSearchResults.length}명 추가 가능${
                            searchResults.length === 100 ? ' (상위 100)' : ''
                          }`}
                    </span>
                  </div>
                  {searchSelectedIds.size > 0 && (
                    <Button
                      size="sm"
                      variant="default"
                      className="h-6 text-[11px] px-2"
                      disabled={addManyToGroup.isPending}
                      onClick={handleAddSelected}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      선택 추가
                    </Button>
                  )}
                </div>
              )}

              <div className="divide-y max-h-64 overflow-y-auto">
                {searchResults.length === 0 ? (
                  <div className="p-3 text-xs text-muted-foreground text-center">
                    검색 결과가 없습니다.
                  </div>
                ) : (
                  searchResults.map((contact) => {
                    const alreadyMember = memberIds.has(contact.id)
                    const checked = searchSelectedIds.has(contact.id)
                    const opt = CUSTOMER_TYPE_OPTIONS.find(
                      (o) => o.value === contact.customer_type
                    )
                    return (
                      <div
                        key={contact.id}
                        className="flex items-center gap-2 px-3 py-2"
                      >
                        <Checkbox
                          checked={alreadyMember ? false : checked}
                          disabled={alreadyMember}
                          onCheckedChange={(v) => toggleSearchSelect(contact.id, !!v)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium truncate">
                              {contact.name ?? contact.email}
                            </span>
                            {opt && contact.customer_type !== 'general' && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  'text-[10px] py-0 px-1.5 h-4 border',
                                  opt.className
                                )}
                              >
                                {opt.label}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {contact.email}
                            {contact.company ? ` · ${contact.company}` : ''}
                            {contact.job_title ? ` · ${contact.job_title}` : ''}
                            {contact.department ? ` · ${contact.department}` : ''}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant={alreadyMember ? 'outline' : 'default'}
                          className="h-7 text-xs shrink-0"
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
