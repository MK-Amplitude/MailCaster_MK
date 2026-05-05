import { useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/common/StatusBadge'
import {
  MoreHorizontal,
  Pencil,
  Trash2,
  UserX,
  UserCheck,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CUSTOMER_TYPE_OPTIONS, type ContactWithGroups, type CustomerType } from '@/types/contact'
import { formatDate, cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'
import type { ContactSort, ContactSortField } from '@/hooks/useContacts'

// 정렬 가능한 컬럼 헤더 — 클릭 시 asc → desc 토글, 다른 컬럼 클릭 시 asc 부터 시작.
function SortableHeader({
  field,
  current,
  onChange,
  children,
}: {
  field: ContactSortField
  current?: ContactSort
  onChange?: (next: ContactSort) => void
  children: React.ReactNode
}) {
  const active = current?.field === field
  const dir = active ? current?.dir : null

  if (!onChange) {
    return <>{children}</>
  }

  const handleClick = () => {
    if (!active) onChange({ field, dir: 'asc' })
    else onChange({ field, dir: dir === 'asc' ? 'desc' : 'asc' })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'flex items-center gap-1 hover:text-foreground transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {children}
      <span className={active ? 'opacity-100' : 'opacity-40'}>
        {dir === 'asc' ? (
          <ChevronUp className="w-3 h-3" />
        ) : dir === 'desc' ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3" />
        )}
      </span>
    </button>
  )
}

function CustomerTypeBadge({ type }: { type: string | null | undefined }) {
  // 'general' 은 기본값이고 시각적 노이즈를 줄이기 위해 표시 생략.
  // 명시적으로 분류된 두 케이스만 강조.
  if (!type || type === 'general') return null
  const opt = CUSTOMER_TYPE_OPTIONS.find((o) => o.value === (type as CustomerType))
  if (!opt) return null
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px] py-0 px-1.5 h-4 border', opt.className)}
    >
      {opt.label}
    </Badge>
  )
}

interface ContactsTableProps {
  contacts: ContactWithGroups[]
  loading: boolean
  selectedIds: Set<string>
  onSelectId: (id: string, checked: boolean) => void
  onSelectAll: (checked: boolean) => void
  onEdit: (contact: ContactWithGroups) => void
  onDelete: (contact: ContactWithGroups) => void
  onToggleUnsubscribe: (contact: ContactWithGroups) => void
  onRowClick: (contact: ContactWithGroups) => void
  /** 현재 정렬 상태. 미제공 시 헤더는 클릭 불가 (정렬 없음). */
  sort?: ContactSort
  onSortChange?: (next: ContactSort) => void
}

export function ContactsTable({
  contacts,
  loading,
  selectedIds,
  onSelectId,
  onSelectAll,
  onEdit,
  onDelete,
  onToggleUnsubscribe,
  onRowClick,
  sort,
  onSortChange,
}: ContactsTableProps) {
  const { user, isOrgAdmin } = useAuth()
  const allSelected = contacts.length > 0 && contacts.every((c) => selectedIds.has(c.id))
  const someSelected = contacts.some((c) => selectedIds.has(c.id))
  // RLS 가 own or admin 을 허용 — UI 도 동일하게 게이팅.
  // 본인이 오너이거나 org admin 이면 수정/삭제/수신거부 토글 가능.
  const canMutate = (c: ContactWithGroups) => c.user_id === user?.id || isOrgAdmin

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                onCheckedChange={(v) => onSelectAll(!!v)}
              />
            </TableHead>
            <TableHead>
              <SortableHeader field="name" current={sort} onChange={onSortChange}>
                이름 / 이메일
              </SortableHeader>
            </TableHead>
            <TableHead className="hidden sm:table-cell">
              <SortableHeader field="parent_group" current={sort} onChange={onSortChange}>
                그룹사
              </SortableHeader>
            </TableHead>
            <TableHead className="hidden sm:table-cell">
              <SortableHeader field="company_ko" current={sort} onChange={onSortChange}>
                회사 / 직책
              </SortableHeader>
            </TableHead>
            <TableHead className="hidden md:table-cell">그룹</TableHead>
            <TableHead className="hidden xl:table-cell">
              <SortableHeader field="owner_name" current={sort} onChange={onSortChange}>
                소유자
              </SortableHeader>
            </TableHead>
            <TableHead className="hidden lg:table-cell">
              <SortableHeader field="created_at" current={sort} onChange={onSortChange}>
                등록일
              </SortableHeader>
            </TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {contacts.map((contact) => (
            <TableRow
              key={contact.id}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => onRowClick(contact)}
            >
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={selectedIds.has(contact.id)}
                  onCheckedChange={(v) => onSelectId(contact.id, !!v)}
                />
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-sm truncate max-w-[180px] sm:max-w-none">
                      {contact.name ?? '이름 없음'}
                    </span>
                    <CustomerTypeBadge type={contact.customer_type} />
                    <StatusBadge
                      isUnsubscribed={contact.is_unsubscribed}
                      isBounced={contact.is_bounced}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground truncate max-w-[200px] sm:max-w-none">
                    {contact.email}
                  </span>
                  {/* 모바일 전용: 회사/그룹사/그룹 컬럼이 숨겨지므로 이름 셀 안에 요약 표시. */}
                  <div className="sm:hidden flex flex-col gap-1 mt-0.5">
                    {contact.parent_group && (
                      <Badge
                        variant="outline"
                        className="text-[10px] py-0 px-1.5 h-4 self-start border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 bg-violet-50/60 dark:bg-violet-900/20"
                      >
                        {contact.parent_group}
                      </Badge>
                    )}
                    {(contact.company || contact.job_title) && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[220px]">
                        {contact.company ?? ''}
                        {contact.company && contact.job_title ? ' · ' : ''}
                        {contact.job_title ?? ''}
                      </span>
                    )}
                    {contact.groups.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {contact.groups.slice(0, 2).map((g) => (
                          <Badge
                            key={g.group_id}
                            variant="outline"
                            className="text-[10px] py-0 px-1.5 h-4"
                            style={
                              g.category_color
                                ? { borderColor: g.category_color, color: g.category_color }
                                : undefined
                            }
                          >
                            {g.group_name}
                          </Badge>
                        ))}
                        {contact.groups.length > 2 && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4">
                            +{contact.groups.length - 2}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </TableCell>
              {/* 그룹사 — 이름 다음, 회사 앞에 위치. AI 가 식별한 한국 대기업 계열사. */}
              <TableCell className="hidden sm:table-cell">
                {contact.parent_group ? (
                  <Badge
                    variant="outline"
                    className="text-xs py-0 px-2 h-5 border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 bg-violet-50/60 dark:bg-violet-900/20"
                    title="그룹사 (AI 식별)"
                  >
                    {contact.parent_group}
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-sm">{contact.company ?? '-'}</span>
                    {contact.company_lookup_status === 'resolved' &&
                      (contact.company_ko || contact.company_en) && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] py-0 px-1 bg-primary/10 text-primary"
                          title={`${contact.company_ko ?? ''} / ${contact.company_en ?? ''}`}
                        >
                          공식
                        </Badge>
                      )}
                  </div>
                  {contact.company_ko && contact.company_ko !== contact.company && (
                    <span className="text-[10px] text-muted-foreground truncate">
                      {contact.company_ko}
                      {contact.company_en ? ` · ${contact.company_en}` : ''}
                    </span>
                  )}
                  {contact.job_title && (
                    <span className="text-xs text-muted-foreground">{contact.job_title}</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <div className="flex flex-wrap gap-1">
                  {contact.groups.slice(0, 3).map((g) => (
                    <Badge
                      key={g.group_id}
                      variant="outline"
                      className="text-xs py-0 px-1.5"
                      style={
                        g.category_color
                          ? { borderColor: g.category_color, color: g.category_color }
                          : undefined
                      }
                    >
                      {g.group_name}
                    </Badge>
                  ))}
                  {contact.groups.length > 3 && (
                    <Badge variant="outline" className="text-xs py-0 px-1.5">
                      +{contact.groups.length - 3}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="hidden xl:table-cell text-xs">
                <div className="flex flex-col gap-0.5">
                  <span className="truncate max-w-[140px]">
                    {contact.owner_name ?? contact.owner_email ?? '-'}
                  </span>
                  {contact.owner_name && contact.owner_email && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">
                      {contact.owner_email}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                {formatDate(contact.created_at)}
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                {canMutate(contact) ? (
                  <RowMenu
                    contact={contact}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onToggleUnsubscribe={onToggleUnsubscribe}
                  />
                ) : (
                  // 메뉴 칸 레이아웃 유지 — 보이지 않는 placeholder
                  <div className="h-7 w-7" />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function RowMenu({
  contact,
  onEdit,
  onDelete,
  onToggleUnsubscribe,
}: {
  contact: ContactWithGroups
  onEdit: (c: ContactWithGroups) => void
  onDelete: (c: ContactWithGroups) => void
  onToggleUnsubscribe: (c: ContactWithGroups) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => { onEdit(contact); setOpen(false) }}>
          <Pencil className="w-4 h-4 mr-2" /> 수정
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => { onToggleUnsubscribe(contact); setOpen(false) }}>
          {contact.is_unsubscribed
            ? <><UserCheck className="w-4 h-4 mr-2" /> 수신거부 해제</>
            : <><UserX className="w-4 h-4 mr-2" /> 수신거부</>
          }
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => { onDelete(contact); setOpen(false) }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="w-4 h-4 mr-2" /> 삭제
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
