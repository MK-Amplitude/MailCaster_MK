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
import { MoreHorizontal, Pencil, Trash2, UserX, UserCheck } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ContactWithGroups } from '@/types/contact'
import { formatDate } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'

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
            <TableHead>이름 / 이메일</TableHead>
            <TableHead className="hidden sm:table-cell">회사 / 직책</TableHead>
            <TableHead className="hidden md:table-cell">그룹</TableHead>
            <TableHead className="hidden xl:table-cell">소유자</TableHead>
            <TableHead className="hidden lg:table-cell">등록일</TableHead>
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
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm truncate max-w-[180px] sm:max-w-none">
                      {contact.name ?? '이름 없음'}
                    </span>
                    <StatusBadge
                      isUnsubscribed={contact.is_unsubscribed}
                      isBounced={contact.is_bounced}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground truncate max-w-[200px] sm:max-w-none">
                    {contact.email}
                  </span>
                  {/* 모바일 전용: 회사/그룹 컬럼이 숨겨지므로 이름 셀 안에 요약 표시.
                      - 회사 + 직책이 있으면 한 줄로, 아래에 그룹 뱃지 최대 2개 */}
                  <div className="sm:hidden flex flex-col gap-1 mt-0.5">
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
              <TableCell className="hidden sm:table-cell">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
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
