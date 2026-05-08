// 관계 관리 대시보드.
// - 연락처별 발송/오픈/답장/마지막 연락 시점을 한눈에
// - 분류·그룹사·참여도 tier 로 필터
// - 행 선택 → "메일 보내기" 버튼 → CampaignWizard 로 pre-selected 이동
// - 행 클릭 → 상세 sheet (인라인 편집 가능)

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/common/EmptyState'
import { ContactDetailSheet } from '@/components/contacts/ContactDetailSheet'
import { ContactFormDialog } from '@/components/contacts/ContactFormDialog'
import {
  Send,
  Search,
  Eye,
  Reply,
  Mail,
  Clock,
  Users,
  TrendingUp,
  Heart,
} from 'lucide-react'
import { matchesSearch } from '@/lib/search'
import { cn } from '@/lib/utils'
import {
  useContactById,
  useToggleUnsubscribe,
  useParentGroupOptions,
} from '@/hooks/useContacts'
import { useContactEngagement } from '@/hooks/useContactEngagement'
import {
  CUSTOMER_TYPE_OPTIONS,
  type CustomerType,
  type ContactWithGroups,
} from '@/types/contact'
import {
  ENGAGEMENT_TIER_OPTIONS,
  computeTier,
  type EngagementTier,
} from '@/types/engagement'

export default function EngagementPage() {
  const navigate = useNavigate()
  const { data: rows = [], isLoading } = useContactEngagement()
  const { data: parentGroupOptions = [] } = useParentGroupOptions()

  const [search, setSearch] = useState('')
  const [customerType, setCustomerType] = useState<CustomerType | 'all'>('all')
  const [parentGroup, setParentGroup] = useState<string | 'all' | '__none__'>('all')
  const [tierFilter, setTierFilter] = useState<EngagementTier | 'all'>('all')
  const [sortKey, setSortKey] = useState<
    'last_sent_at' | 'total_opens' | 'reply_count' | 'total_sent'
  >('last_sent_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openContactId, setOpenContactId] = useState<string | null>(null)
  const [editContact, setEditContact] = useState<ContactWithGroups | null>(null)
  const [editFormOpen, setEditFormOpen] = useState(false)

  const { data: openContact = null } = useContactById(openContactId)
  const toggleUnsub = useToggleUnsubscribe()

  // tier 계산은 row 한번에 수행해 정렬·필터링에 재사용
  const enriched = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        tier: computeTier(r.last_sent_at),
      })),
    [rows]
  )

  const filtered = useMemo(() => {
    const q = search.trim()
    return enriched.filter((r) => {
      if (customerType !== 'all') {
        if ((r.customer_type ?? 'general') !== customerType) return false
      }
      if (parentGroup !== 'all') {
        if (parentGroup === '__none__') {
          if (r.parent_group) return false
        } else {
          if (r.parent_group !== parentGroup) return false
        }
      }
      if (tierFilter !== 'all' && r.tier !== tierFilter) return false
      if (q) {
        return (
          matchesSearch(r.name, q) ||
          matchesSearch(r.email, q) ||
          matchesSearch(r.company, q) ||
          matchesSearch(r.company_ko, q) ||
          matchesSearch(r.parent_group, q) ||
          matchesSearch(r.department, q) ||
          matchesSearch(r.job_title, q)
        )
      }
      return true
    })
  }, [enriched, search, customerType, parentGroup, tierFilter])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = sortKey === 'last_sent_at'
        ? (a.last_sent_at ? new Date(a.last_sent_at).getTime() : 0)
        : (a[sortKey] as number) || 0
      const bv = sortKey === 'last_sent_at'
        ? (b.last_sent_at ? new Date(b.last_sent_at).getTime() : 0)
        : (b[sortKey] as number) || 0
      return (av - bv) * dir
    })
  }, [filtered, sortKey, sortDir])

  // 상단 stats — 항상 unfiltered 기준 (전체 분포)
  const stats = useMemo(() => {
    const acc = { total: 0, active: 0, dormant: 0, never: 0, totalReplies: 0 }
    for (const r of enriched) {
      if (r.is_unsubscribed || r.is_bounced) continue
      acc.total++
      if (r.tier === 'active') acc.active++
      if (r.tier === 'dormant' || r.tier === 'cold') acc.dormant++
      if (r.tier === 'never') acc.never++
      acc.totalReplies += r.reply_count
    }
    return acc
  }, [enriched])

  const allFilteredSelected =
    sorted.length > 0 && sorted.every((r) => selectedIds.has(r.id))
  const someFilteredSelected = sorted.some((r) => selectedIds.has(r.id))

  const toggleSelect = (id: string, checked: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })

  const toggleSelectAll = (checked: boolean) =>
    setSelectedIds(checked ? new Set(sorted.map((r) => r.id)) : new Set())

  const sendToSelected = () => {
    if (selectedIds.size === 0) return
    navigate('/campaigns/new', {
      state: { preselectedContactIds: [...selectedIds] },
    })
  }

  const sendToOne = (id: string) => {
    navigate('/campaigns/new', {
      state: { preselectedContactIds: [id] },
    })
  }

  const toggleSort = (key: typeof sortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 헤더 */}
      <div className="px-4 sm:px-6 py-4 border-b">
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Heart className="w-5 h-5 text-rose-500" />
              관계 관리
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              연락처별 발송 이력 · 참여도 · 마지막 연락 시점을 한눈에
            </p>
          </div>
          {selectedIds.size > 0 && (
            <Button size="sm" onClick={sendToSelected}>
              <Send className="w-4 h-4 mr-1.5" />
              선택 {selectedIds.size}명에게 메일
            </Button>
          )}
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <StatCard icon={Users} label="총 연락처" value={stats.total} accent="text-foreground" />
          <StatCard icon={TrendingUp} label="활성 (30일)" value={stats.active} accent="text-green-600" />
          <StatCard icon={Clock} label="뜸함 (90일+)" value={stats.dormant} accent="text-amber-600" />
          <StatCard icon={Mail} label="미발송" value={stats.never} accent="text-muted-foreground" />
        </div>

        {/* 필터 */}
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="이름/이메일/회사/그룹사/부서/직책 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={customerType} onValueChange={(v) => setCustomerType(v as CustomerType | 'all')}>
            <SelectTrigger className="h-8 w-32 text-sm">
              <SelectValue placeholder="분류" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">분류 전체</SelectItem>
              {CUSTOMER_TYPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={parentGroup} onValueChange={(v) => setParentGroup(v)}>
            <SelectTrigger className="h-8 w-36 text-sm">
              <SelectValue placeholder="그룹사" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">그룹사 전체</SelectItem>
              <SelectItem value="__none__">그룹 미소속</SelectItem>
              {parentGroupOptions.map((g) => (
                <SelectItem key={g} value={g}>{g}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as EngagementTier | 'all')}>
            <SelectTrigger className="h-8 w-36 text-sm">
              <SelectValue placeholder="참여도" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">참여도 전체</SelectItem>
              {ENGAGEMENT_TIER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 테이블 */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={Mail}
            title="조건에 맞는 연락처가 없습니다"
            description="필터를 조정해보세요."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      allFilteredSelected ? true : someFilteredSelected ? 'indeterminate' : false
                    }
                    onCheckedChange={(v) => toggleSelectAll(!!v)}
                  />
                </TableHead>
                <TableHead>이름 / 이메일</TableHead>
                <TableHead className="hidden sm:table-cell">그룹사 / 회사</TableHead>
                <TableHead className="hidden md:table-cell">분류</TableHead>
                <TableHead>
                  <SortBtn active={sortKey === 'last_sent_at'} dir={sortDir} onClick={() => toggleSort('last_sent_at')}>
                    마지막 연락
                  </SortBtn>
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  <SortBtn active={sortKey === 'total_sent'} dir={sortDir} onClick={() => toggleSort('total_sent')}>
                    발송
                  </SortBtn>
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  <SortBtn active={sortKey === 'total_opens'} dir={sortDir} onClick={() => toggleSort('total_opens')}>
                    오픈
                  </SortBtn>
                </TableHead>
                <TableHead className="hidden xl:table-cell">
                  <SortBtn active={sortKey === 'reply_count'} dir={sortDir} onClick={() => toggleSort('reply_count')}>
                    답장
                  </SortBtn>
                </TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => {
                const checked = selectedIds.has(r.id)
                const customerOpt = CUSTOMER_TYPE_OPTIONS.find(
                  (o) => o.value === (r.customer_type ?? 'general')
                )
                const tierOpt = ENGAGEMENT_TIER_OPTIONS.find((o) => o.value === r.tier)
                return (
                  <TableRow
                    key={r.id}
                    className={cn(
                      'cursor-pointer hover:bg-muted/30',
                      (r.is_unsubscribed || r.is_bounced) && 'opacity-50'
                    )}
                    onClick={() => setOpenContactId(r.id)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggleSelect(r.id, !!v)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium truncate max-w-[180px] sm:max-w-none">
                          {r.name ?? '이름 없음'}
                        </span>
                        <span className="text-[11px] text-muted-foreground truncate max-w-[200px] sm:max-w-none">
                          {r.email}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex flex-col gap-0.5">
                        {r.parent_group && (
                          <Badge
                            variant="outline"
                            className="text-[10px] py-0 px-1.5 h-4 self-start border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 bg-violet-50/60 dark:bg-violet-900/20"
                          >
                            {r.parent_group}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                          {r.company_ko ?? r.company ?? '-'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {customerOpt && (
                        <Badge
                          variant="outline"
                          className={cn('text-[10px] py-0 px-1.5 h-4 border', customerOpt.className)}
                        >
                          {customerOpt.label}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        {tierOpt && (
                          <Badge
                            variant="outline"
                            className={cn('text-[10px] py-0 px-1.5 h-4 self-start border', tierOpt.className)}
                          >
                            {tierOpt.label}
                          </Badge>
                        )}
                        <span
                          className="text-[11px] text-muted-foreground"
                          title={r.last_sent_at ? format(new Date(r.last_sent_at), 'yyyy-MM-dd HH:mm') : undefined}
                        >
                          {r.last_sent_at
                            ? formatDistanceToNow(new Date(r.last_sent_at), { addSuffix: true, locale: ko })
                            : '미발송'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm">
                      {r.total_sent}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm">
                      <span className="inline-flex items-center gap-1">
                        <Eye className="w-3 h-3 text-muted-foreground" />
                        {r.total_opens}
                      </span>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-sm">
                      <span className="inline-flex items-center gap-1">
                        <Reply className="w-3 h-3 text-muted-foreground" />
                        {r.reply_count}
                      </span>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => sendToOne(r.id)}
                        title="이 사람에게 메일 보내기"
                        disabled={r.is_unsubscribed || r.is_bounced}
                      >
                        <Send className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <ContactDetailSheet
        contact={openContact}
        open={!!openContactId}
        onOpenChange={(v) => {
          if (!v) setOpenContactId(null)
        }}
        onEdit={(c) => {
          setEditContact(c)
          setEditFormOpen(true)
          setOpenContactId(null)
        }}
        onToggleUnsubscribe={(c) =>
          toggleUnsub.mutate({ id: c.id, unsubscribe: !c.is_unsubscribed })
        }
      />
      <ContactFormDialog
        open={editFormOpen}
        onOpenChange={(v) => {
          setEditFormOpen(v)
          if (!v) setEditContact(null)
        }}
        contact={editContact}
      />
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ElementType
  label: string
  value: number
  accent: string
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2">
          <Icon className={cn('w-4 h-4', accent)} />
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <div className={cn('text-2xl font-semibold mt-1', accent)}>
          {value.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  )
}

function SortBtn({
  active,
  dir,
  onClick,
  children,
}: {
  active: boolean
  dir: 'asc' | 'desc'
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-0.5 hover:text-foreground transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {children}
      <span className={active ? 'opacity-100' : 'opacity-40'}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </button>
  )
}
