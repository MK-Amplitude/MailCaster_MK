// ============================================================
// CommonContactsTable — contacts_common 뷰용 테이블
// ------------------------------------------------------------
// "공통" 스코프에서 같은 이메일의 여러 오너 연락처를 하나의 행으로 보여준다.
// duplicate_count > 1 인 경우 여러 오너 뱃지를 표시.
// 체크박스 선택 시 내부적으로 모든 contact_ids 를 합쳐서 한 번에 처리.
// ============================================================

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
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Users } from 'lucide-react'
import type { ContactCommon } from '@/types/org'

interface CommonContactsTableProps {
  contacts: ContactCommon[]
  loading: boolean
  // 선택 — 공통 테이블에선 email_key 단위로 선택 (같은 이메일의 모든 사본이 함께 선택됨)
  selectedKeys: Set<string>
  onSelectKey: (emailKey: string, checked: boolean) => void
  onSelectAll: (checked: boolean) => void
  onRowClick?: (contact: ContactCommon) => void
}

export function CommonContactsTable({
  contacts,
  loading,
  selectedKeys,
  onSelectKey,
  onSelectAll,
  onRowClick,
}: CommonContactsTableProps) {
  const allSelected =
    contacts.length > 0 && contacts.every((c) => selectedKeys.has(c.email_key))
  const someSelected = contacts.some((c) => selectedKeys.has(c.email_key))

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
            <TableHead className="hidden lg:table-cell">오너</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {contacts.map((c) => {
            const isSelected = selectedKeys.has(c.email_key)
            return (
              <TableRow
                key={c.email_key}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onRowClick?.(c)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={(v) => onSelectKey(c.email_key, !!v)}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-sm truncate max-w-[180px] sm:max-w-none">
                        {c.name ?? '이름 없음'}
                      </span>
                      <StatusBadge
                        isUnsubscribed={c.is_unsubscribed}
                        isBounced={c.is_bounced}
                      />
                      {c.duplicate_count > 1 && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] h-4 px-1.5"
                          title={`${c.duplicate_count}명의 오너가 같은 이메일을 등록`}
                        >
                          <Users className="w-2.5 h-2.5 mr-1" />
                          {c.duplicate_count}
                        </Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground truncate max-w-[200px] sm:max-w-none">
                      {c.email}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm">{c.company ?? '-'}</span>
                    {c.job_title && (
                      <span className="text-xs text-muted-foreground">{c.job_title}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {c.groups.slice(0, 3).map((g) => (
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
                    {c.groups.length > 3 && (
                      <Badge variant="outline" className="text-xs py-0 px-1.5">
                        +{c.groups.length - 3}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {c.owners.map((o) => (
                      <Badge
                        key={o.contact_id}
                        variant="outline"
                        className="text-[10px] py-0 px-1.5 h-5"
                        title={o.owner_email}
                      >
                        {o.owner_name || o.owner_email}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
