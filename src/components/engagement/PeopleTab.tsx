// 관계 관리 — "사람별" 탭. 기존 EngagementPage 의 테이블 로직 추출.
// 차트/인사이트로부터 받은 필터를 props 로 받아 적용.

import { useMemo, useState, useEffect } from 'react'
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
import { Send, Search, Eye, Reply, Mail, Clock, Wand2 } from 'lucide-react'
import { PersonalizedSendDialog } from '@/components/campaigns/PersonalizedSendDialog'
import { replyCategoryOption } from '@/types/replyCategory'
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
  computeTouchBucket,
  isDueForTouch,
  isOverdue,
  TOUCH_BUCKETS,
  type EngagementTier,
  type ContactEngagementRow,
  type TouchBucket,
} from '@/types/engagement'

// 상위 (EngagementPage) 가 차트/인사이트 클릭으로 설정하는 필터.
//   - 차트 클릭(additive): 정의된 필드만 덮어쓰기 (다른 필터 유지)
//   - 인사이트 클릭(replace): _replace=true → 모든 필터 초기화 후 적용
export interface PeopleTabExternalFilter {
  customerType?: CustomerType | 'all'
  customerTypes?: CustomerType[]    // 다중 — 비면 customerType 사용
  parentGroup?: string | 'all' | '__none__'
  tier?: EngagementTier | 'all'
  tiers?: EngagementTier[]
  touchBucket?: TouchBucket          // fine-grained 6 버킷
  noReply?: boolean
  hasReply?: boolean
  dueForTouch?: boolean              // cadence 임박 또는 초과
  overdueOnly?: boolean              // cadence 초과만 (강한 신호)
  _replace?: boolean
}

interface Props {
  externalFilter?: PeopleTabExternalFilter
  /** 외부 필터가 적용되었음을 시각적으로 알리는 콜백 */
  onClearExternal?: () => void
}

export function PeopleTab({ externalFilter, onClearExternal }: Props) {
  const navigate = useNavigate()
  const { data: rows = [], isLoading } = useContactEngagement()
  const { data: parentGroupOptions = [] } = useParentGroupOptions()

  const [search, setSearch] = useState('')
  const [customerType, setCustomerType] = useState<CustomerType | 'all'>('all')
  const [customerTypes, setCustomerTypes] = useState<CustomerType[]>([])
  const [parentGroup, setParentGroup] = useState<string | 'all' | '__none__'>('all')
  const [tierFilter, setTierFilter] = useState<EngagementTier | 'all'>('all')
  const [extraTiers, setExtraTiers] = useState<EngagementTier[]>([])
  const [touchBucket, setTouchBucket] = useState<TouchBucket | undefined>(undefined)
  const [noReplyOnly, setNoReplyOnly] = useState(false)
  const [hasReplyOnly, setHasReplyOnly] = useState(false)
  const [dueForTouchOnly, setDueForTouchOnly] = useState(false)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [sortKey, setSortKey] = useState<
    'last_sent_at' | 'total_opens' | 'reply_count' | 'total_sent'
  >('last_sent_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // 외부 필터 적용
  useEffect(() => {
    if (!externalFilter) return
    if (externalFilter._replace) {
      // 인사이트 클릭 — 다른 모든 필터 초기화 후 명시된 것만 적용
      setCustomerType(externalFilter.customerType ?? 'all')
      setCustomerTypes(externalFilter.customerTypes ?? [])
      setParentGroup(externalFilter.parentGroup ?? 'all')
      setTierFilter(externalFilter.tier ?? 'all')
      setExtraTiers(externalFilter.tiers ?? [])
      setTouchBucket(externalFilter.touchBucket)
      setNoReplyOnly(externalFilter.noReply ?? false)
      setHasReplyOnly(externalFilter.hasReply ?? false)
      setDueForTouchOnly(externalFilter.dueForTouch ?? false)
      setOverdueOnly(externalFilter.overdueOnly ?? false)
      return
    }
    if (externalFilter.customerType !== undefined) setCustomerType(externalFilter.customerType)
    if (externalFilter.customerTypes !== undefined) setCustomerTypes(externalFilter.customerTypes)
    if (externalFilter.parentGroup !== undefined) setParentGroup(externalFilter.parentGroup)
    if (externalFilter.tier !== undefined) setTierFilter(externalFilter.tier)
    if (externalFilter.tiers !== undefined) setExtraTiers(externalFilter.tiers)
    if (externalFilter.touchBucket !== undefined) setTouchBucket(externalFilter.touchBucket)
    if (externalFilter.noReply !== undefined) setNoReplyOnly(externalFilter.noReply)
    if (externalFilter.hasReply !== undefined) setHasReplyOnly(externalFilter.hasReply)
    if (externalFilter.dueForTouch !== undefined) setDueForTouchOnly(externalFilter.dueForTouch)
    if (externalFilter.overdueOnly !== undefined) setOverdueOnly(externalFilter.overdueOnly)
  }, [externalFilter])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openContactId, setOpenContactId] = useState<string | null>(null)
  const [editContact, setEditContact] = useState<ContactWithGroups | null>(null)
  const [editFormOpen, setEditFormOpen] = useState(false)
  const [personalizeOpen, setPersonalizeOpen] = useState(false)

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
    const tiersSet = extraTiers.length > 0 ? new Set(extraTiers) : null
    const typesSet = customerTypes.length > 0 ? new Set(customerTypes) : null
    return enriched.filter((r) => {
      const ct = (r.customer_type ?? 'general') as CustomerType
      // 다중 customerTypes 가 우선; 없으면 단일 customerType
      if (typesSet) {
        if (!typesSet.has(ct)) return false
      } else if (customerType !== 'all') {
        if (ct !== customerType) return false
      }
      if (parentGroup !== 'all') {
        if (parentGroup === '__none__') {
          if (r.parent_group) return false
        } else {
          if (r.parent_group !== parentGroup) return false
        }
      }
      if (tiersSet) {
        if (!tiersSet.has(r.tier)) return false
      } else if (tierFilter !== 'all' && r.tier !== tierFilter) return false
      if (touchBucket && computeTouchBucket(r.last_sent_at) !== touchBucket) return false
      if (noReplyOnly && (r.reply_count > 0 || r.total_sent === 0)) return false
      if (hasReplyOnly && r.reply_count === 0) return false
      if (overdueOnly && !isOverdue(r.customer_type, r.last_sent_at)) return false
      if (dueForTouchOnly && !overdueOnly && !isDueForTouch(r.customer_type, r.last_sent_at))
        return false
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
  }, [
    enriched,
    search,
    customerType,
    customerTypes,
    parentGroup,
    tierFilter,
    extraTiers,
    touchBucket,
    noReplyOnly,
    hasReplyOnly,
    dueForTouchOnly,
    overdueOnly,
  ])

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
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const hasActiveFilter =
    customerType !== 'all' ||
    customerTypes.length > 0 ||
    parentGroup !== 'all' ||
    tierFilter !== 'all' ||
    extraTiers.length > 0 ||
    touchBucket !== undefined ||
    noReplyOnly ||
    hasReplyOnly ||
    dueForTouchOnly ||
    overdueOnly

  const clearAll = () => {
    setCustomerType('all')
    setCustomerTypes([])
    setParentGroup('all')
    setTierFilter('all')
    setExtraTiers([])
    setTouchBucket(undefined)
    setNoReplyOnly(false)
    setHasReplyOnly(false)
    setDueForTouchOnly(false)
    setOverdueOnly(false)
    onClearExternal?.()
  }

  const extraTiersLabel = useMemo(
    () =>
      extraTiers
        .map((t) => ENGAGEMENT_TIER_OPTIONS.find((o) => o.value === t)?.label ?? t)
        .join(' · '),
    [extraTiers]
  )

  const customerTypesLabel = useMemo(
    () =>
      customerTypes
        .map((t) => CUSTOMER_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t)
        .join(' · '),
    [customerTypes]
  )

  const touchBucketLabel = useMemo(
    () => TOUCH_BUCKETS.find((b) => b.value === touchBucket)?.label ?? '',
    [touchBucket]
  )

  return (
    <div className="flex flex-col h-full">
      {/* 필터 바 */}
      <div className="px-4 sm:px-6 py-3 border-b">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="이름/이메일/회사/그룹사/부서/직책 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            value={customerType}
            onValueChange={(v) => {
              setCustomerTypes([])
              setCustomerType(v as CustomerType | 'all')
            }}
            disabled={customerTypes.length > 0}
          >
            <SelectTrigger className="h-8 w-32 text-sm"><SelectValue placeholder="분류" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">분류 전체</SelectItem>
              {CUSTOMER_TYPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={parentGroup} onValueChange={(v) => setParentGroup(v)}>
            <SelectTrigger className="h-8 w-36 text-sm"><SelectValue placeholder="그룹사" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">그룹사 전체</SelectItem>
              <SelectItem value="__none__">그룹 미소속</SelectItem>
              {parentGroupOptions.map((g) => (
                <SelectItem key={g} value={g}>{g}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={tierFilter}
            onValueChange={(v) => {
              setExtraTiers([]) // 단일 선택 시 다중 해제
              setTierFilter(v as EngagementTier | 'all')
            }}
            disabled={extraTiers.length > 0}
          >
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
          {customerTypes.length > 0 && (
            <Badge
              variant="outline"
              className="h-7 text-xs gap-1.5 cursor-pointer"
              onClick={() => setCustomerTypes([])}
              title={customerTypesLabel}
            >
              분류: {customerTypesLabel} ✕
            </Badge>
          )}
          {extraTiers.length > 0 && (
            <Badge
              variant="outline"
              className="h-7 text-xs gap-1.5 cursor-pointer"
              onClick={() => setExtraTiers([])}
              title={extraTiersLabel}
            >
              참여도: {extraTiersLabel} ✕
            </Badge>
          )}
          {touchBucket && (
            <Badge
              variant="outline"
              className="h-7 text-xs gap-1.5 cursor-pointer"
              onClick={() => setTouchBucket(undefined)}
            >
              터치: {touchBucketLabel} ✕
            </Badge>
          )}
          {overdueOnly && (
            <Badge
              variant="outline"
              className="h-7 text-xs gap-1.5 cursor-pointer text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900"
              onClick={() => setOverdueOnly(false)}
            >
              <Clock className="w-3 h-3" />
              주기 초과만 ✕
            </Badge>
          )}
          {dueForTouchOnly && !overdueOnly && (
            <Badge
              variant="outline"
              className="h-7 text-xs gap-1.5 cursor-pointer text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900"
              onClick={() => setDueForTouchOnly(false)}
            >
              <Clock className="w-3 h-3" />
              지금 터치 권장 ✕
            </Badge>
          )}
          {noReplyOnly && (
            <Badge variant="outline" className="h-7 text-xs gap-1.5 cursor-pointer" onClick={() => setNoReplyOnly(false)}>
              답장 없음만 ✕
            </Badge>
          )}
          {hasReplyOnly && (
            <Badge variant="outline" className="h-7 text-xs gap-1.5 cursor-pointer" onClick={() => setHasReplyOnly(false)}>
              답장 있음만 ✕
            </Badge>
          )}
          {hasActiveFilter && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearAll}>
              필터 초기화
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground tabular-nums">
            {sorted.length.toLocaleString()}명
          </span>
          {selectedIds.size > 0 && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPersonalizeOpen(true)}
                className="h-8"
                title="사람마다 다른 본문을 AI 가 생성"
              >
                <Wand2 className="w-3.5 h-3.5 mr-1.5" />
                AI 개인화
              </Button>
              <Button size="sm" onClick={sendToSelected} className="h-8">
                <Send className="w-3.5 h-3.5 mr-1.5" />
                {selectedIds.size}명에게 메일
              </Button>
            </>
          )}
        </div>
      </div>

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
                    checked={allFilteredSelected ? true : someFilteredSelected ? 'indeterminate' : false}
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
              {sorted.map((r) => (
                <PersonRow
                  key={r.id}
                  row={r}
                  checked={selectedIds.has(r.id)}
                  onToggleSelect={(v) => toggleSelect(r.id, v)}
                  onClickRow={() => setOpenContactId(r.id)}
                  onSend={() => sendToOne(r.id)}
                />
              ))}
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
      <PersonalizedSendDialog
        open={personalizeOpen}
        onOpenChange={setPersonalizeOpen}
        contacts={sorted
          .filter((r) => selectedIds.has(r.id) && !r.is_unsubscribed && !r.is_bounced)
          .map((r) => ({ id: r.id, name: r.name, email: r.email }))}
      />
    </div>
  )
}

function PersonRow({
  row: r,
  checked,
  onToggleSelect,
  onClickRow,
  onSend,
}: {
  row: ContactEngagementRow & { tier: EngagementTier }
  checked: boolean
  onToggleSelect: (v: boolean) => void
  onClickRow: () => void
  onSend: () => void
}) {
  const customerOpt = CUSTOMER_TYPE_OPTIONS.find(
    (o) => o.value === (r.customer_type ?? 'general')
  )
  const tierOpt = ENGAGEMENT_TIER_OPTIONS.find((o) => o.value === r.tier)
  return (
    <TableRow
      className={cn(
        'cursor-pointer hover:bg-muted/30',
        (r.is_unsubscribed || r.is_bounced) && 'opacity-50'
      )}
      onClick={onClickRow}
    >
      <TableCell onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={(v) => onToggleSelect(!!v)} />
      </TableCell>
      <TableCell>
        <div className="flex flex-col min-w-0">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-sm font-medium truncate max-w-[140px] sm:max-w-[180px] md:max-w-[220px]">
              {r.name ?? '이름 없음'}
            </span>
            {(r.display_title || r.job_title) && (
              <span className="text-[11px] text-muted-foreground truncate max-w-[120px] sm:max-w-[160px] shrink-0">
                {r.display_title || r.job_title}
              </span>
            )}
          </div>
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
          <Badge variant="outline" className={cn('text-[10px] py-0 px-1.5 h-4 border', customerOpt.className)}>
            {customerOpt.label}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          {tierOpt && (
            <Badge variant="outline" className={cn('text-[10px] py-0 px-1.5 h-4 self-start border', tierOpt.className)}>
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
      <TableCell className="hidden lg:table-cell text-sm">{r.total_sent}</TableCell>
      <TableCell className="hidden lg:table-cell text-sm">
        <span className="inline-flex items-center gap-1">
          <Eye className="w-3 h-3 text-muted-foreground" />
          {r.total_opens}
        </span>
      </TableCell>
      <TableCell className="hidden xl:table-cell text-sm">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Reply className="w-3 h-3 text-muted-foreground" />
            {r.reply_count}
          </span>
          {/* 마지막 답장의 분류 + 내 답장 대기 여부를 row 에서 바로 보이게 */}
          {(() => {
            // last_campaign JSONB 안에 reply_category 가 들어있음 (migration 029).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lc = (r as any).last_campaign as
              | { reply_category?: string | null }
              | null
            const cat = (lc?.reply_category ?? null) as
              | 'interested'
              | 'not_interested'
              | 'question'
              | 'out_of_office'
              | 'unclear'
              | null
            const catOpt = cat ? replyCategoryOption(cat) : null
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const awaiting = ((r as any).awaiting_my_response_count ?? 0) > 0
            return (
              <>
                {catOpt && (
                  <span
                    className={cn(
                      'inline-flex items-center text-[10px] px-1.5 py-0 h-4 rounded border',
                      catOpt.className
                    )}
                    title={`마지막 답장 톤: ${catOpt.hint}`}
                  >
                    {catOpt.label}
                  </span>
                )}
                {awaiting && (
                  <span
                    className="inline-flex items-center text-[10px] px-1.5 py-0 h-4 rounded border bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border-rose-200 dark:border-rose-800"
                    title="고객이 답장했는데 내가 아직 답장 안 함"
                  >
                    내 답장 대기
                  </span>
                )}
              </>
            )
          })()}
        </div>
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={onSend}
          title="이 사람에게 메일 보내기"
          disabled={r.is_unsubscribed || r.is_bounced}
        >
          <Send className="w-3.5 h-3.5" />
        </Button>
      </TableCell>
    </TableRow>
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
