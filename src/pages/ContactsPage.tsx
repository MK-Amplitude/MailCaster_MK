import { useState, useMemo, useRef, useDeferredValue } from 'react'
import { matchesSearch } from '@/lib/search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ContactsTable } from '@/components/contacts/ContactsTable'
import { CommonContactsTable } from '@/components/contacts/CommonContactsTable'
import { ContactFormDialog } from '@/components/contacts/ContactFormDialog'
import { ContactDetailSheet } from '@/components/contacts/ContactDetailSheet'
import { ContactImportDialog } from '@/components/contacts/ContactImportDialog'
import { AddToGroupDialog } from '@/components/contacts/AddToGroupDialog'
import { AddToSequenceDialog } from '@/components/contacts/AddToSequenceDialog'
import { BulkActionBar } from '@/components/common/BulkActionBar'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import {
  useContacts,
  useContactsCommon,
  useContactById,
  useDeleteContacts,
  useToggleUnsubscribe,
  useClearBounce,
  useBulkToggleUnsubscribe,
  useBulkUpdateCustomerType,
  useBulkArchiveContacts,
  useArchiveInactiveContacts,
  useParentGroupOptions,
  type ContactScope,
  type ContactSort,
} from '@/hooks/useContacts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UserPlus, Upload, Users, Search, UserX, Trash2, FolderPlus, Tag, Wand2, ScanLine, Loader2, Archive, ArchiveRestore, RotateCcw, Sparkles, Workflow, Merge } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { resolveCompaniesBatch } from '@/lib/resolveCompany'
import { PersonalizedSendDialog } from '@/components/campaigns/PersonalizedSendDialog'
import { MergeContactsDialog } from '@/components/contacts/MergeContactsDialog'
import { useOcrBusinessCard, type OcrFields } from '@/hooks/useOcrBusinessCard'
import { toast } from 'sonner'
import {
  CUSTOMER_TYPE_OPTIONS,
  type ContactWithGroups,
  type ContactStatus,
  type CustomerType,
} from '@/types/contact'

// 연락처 스코프 확장:
//   'mine' = 내가 오너인 연락처만
//   'org'  = 조직 전체 (중복 유지, 오너 컬럼 표시)
//   'common' = dedupe 뷰 — 같은 이메일 묶음 하나의 행, 모든 오너 뱃지
type ScopeValue = ContactScope | 'common'

export default function ContactsPage() {
  const qc = useQueryClient()
  const [scope, setScope] = useState<ScopeValue>('org')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ContactStatus>('all')
  const [customerType, setCustomerType] = useState<CustomerType | 'all'>('all')
  const [parentGroup, setParentGroup] = useState<string | 'all' | '__none__'>('all')
  const [sort, setSort] = useState<ContactSort>({ field: 'created_at', dir: 'desc' })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedCommonKeys, setSelectedCommonKeys] = useState<Set<string>>(new Set())
  const [formOpen, setFormOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editContact, setEditContact] = useState<ContactWithGroups | null>(null)
  // detail sheet 는 id 만 보관하고 실제 데이터는 contacts 리스트에서 lookup.
  // 그래야 invalidate / refetch 후 sheet 에 표시되는 데이터도 즉시 fresh — 자유 입력 후
  // "반영 안 됨" 문제 차단.
  const [detailContactId, setDetailContactId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ContactWithGroups | null>(null)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [addToGroupOpen, setAddToGroupOpen] = useState(false)
  const [addToSequenceOpen, setAddToSequenceOpen] = useState(false)
  const [personalizeOpen, setPersonalizeOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const ocr = useOcrBusinessCard()
  const [ocrPrefill, setOcrPrefill] = useState<OcrFields | null>(null)

  // 기본(개별) 스코프용 쿼리 — scope='common' 일 때는 enabled 되더라도 결과를 쓰지 않음
  const {
    data: allContacts = [],
    isLoading: contactsLoading,
  } = useContacts({
    groupIds: [],
    status,
    customerType,
    parentGroup,
    sort,
    scope: scope === 'common' ? 'org' : scope,
  })

  // dedupe 뷰 — scope='common' 전용
  const {
    data: commonContacts = [],
    isLoading: commonLoading,
  } = useContactsCommon()

  // 검색은 deferred 값으로 필터 — 1만 행 테이블이 keystroke 마다 동기 재렌더되어
  // 입력이 버벅이던 문제 완화 (입력은 즉시, 목록은 한 프레임 뒤 갱신).
  const deferredSearch = useDeferredValue(search)

  const contacts = useMemo(() => {
    const q = deferredSearch.trim()
    if (!q) return allContacts
    return allContacts.filter(
      (c) =>
        matchesSearch(c.name, q) ||
        matchesSearch(c.email, q) ||
        matchesSearch(c.company, q) ||
        matchesSearch(c.department, q) ||
        matchesSearch(c.job_title, q)
    )
  }, [allContacts, deferredSearch])

  // 공통 뷰 — 상태/검색 필터를 클라이언트에서 적용 (common 뷰에는 status 필드만 존재).
  // 반송은 'bounced' 로 명시 조회할 때만 노출 — 그 외는 모두 숨겨 검색·그룹 빌더에서 제외.
  const filteredCommon = useMemo(() => {
    let list = commonContacts
    if (status === 'unsubscribed') {
      list = list.filter((c) => c.is_unsubscribed && !c.is_bounced)
    } else if (status === 'bounced') {
      list = list.filter((c) => c.is_bounced)
    } else if (status === 'normal') {
      list = list.filter((c) => !c.is_unsubscribed && !c.is_bounced)
    } else {
      // 'all' (기본) / 'needs_verification' — 반송만 숨김
      list = list.filter((c) => !c.is_bounced)
    }
    const q = deferredSearch.trim()
    if (!q) return list
    return list.filter(
      (c) =>
        matchesSearch(c.name, q) ||
        matchesSearch(c.email, q) ||
        matchesSearch(c.company, q) ||
        matchesSearch(c.department, q) ||
        matchesSearch(c.job_title, q)
    )
  }, [commonContacts, deferredSearch, status])

  const isLoading = scope === 'common' ? commonLoading : contactsLoading
  const displayCount = scope === 'common' ? filteredCommon.length : contacts.length
  const deleteContacts = useDeleteContacts()
  const toggleUnsub = useToggleUnsubscribe()
  const clearBounce = useClearBounce()
  const bulkUnsub = useBulkToggleUnsubscribe()
  const bulkUpdateType = useBulkUpdateCustomerType()
  const bulkArchive = useBulkArchiveContacts()
  const archiveInactive = useArchiveInactiveContacts()

  // 그룹사 필터 옵션 — 별도 쿼리로 unfiltered distinct 값을 가져옴.
  // (allContacts 기반으로 추출하면 '그룹 미소속' 선택 시 옵션이 0개가 되어
  // dropdown 자체가 사라지는 순환 문제가 발생함.)
  const { data: parentGroupOptions = [] } = useParentGroupOptions()

  const handleSelectId = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const handleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(contacts.map((c) => c.id)) : new Set())
  }

  // 공통 테이블의 선택 — email_key 단위. 벌크 액션 시 모든 contact_ids 로 확장.
  const handleSelectCommonKey = (key: string, checked: boolean) => {
    setSelectedCommonKeys((prev) => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const handleSelectAllCommon = (checked: boolean) => {
    setSelectedCommonKeys(
      checked ? new Set(filteredCommon.map((c) => c.email_key)) : new Set()
    )
  }

  // 공통 선택 → 실제 contact_ids 리스트로 펼치기 (각 email_key 마다 여러 오너의 사본)
  const expandedCommonContactIds = useMemo(() => {
    if (selectedCommonKeys.size === 0) return [] as string[]
    const ids: string[] = []
    filteredCommon.forEach((c) => {
      if (selectedCommonKeys.has(c.email_key)) ids.push(...c.contact_ids)
    })
    return ids
  }, [filteredCommon, selectedCommonKeys])

  const activeSelectedCount =
    scope === 'common' ? selectedCommonKeys.size : selectedIds.size

  // 병합 후보 — 개별 스코프에서 선택된 연락처들 (다이얼로그에 그대로 전달)
  const mergeCandidates = useMemo(
    () => contacts.filter((c) => selectedIds.has(c.id)),
    [contacts, selectedIds],
  )

  // 개인화 발송 대상 — useMemo + Set 조회.
  // 기존엔 JSX 안 IIFE 로 매 렌더마다 O(선택수 × 전체행) includes 스캔을 돌려
  // 1만 행 전체 선택 상태에서 keystroke 마다 수 초씩 멈추던 문제.
  const personalizeTargets = useMemo(() => {
    const idSet = new Set(scope === 'common' ? expandedCommonContactIds : [...selectedIds])
    if (idSet.size === 0) return []
    return contacts
      .filter((c) => idSet.has(c.id) && !c.is_unsubscribed && !c.is_bounced)
      .map((c) => ({ id: c.id, name: c.name, email: c.email }))
  }, [contacts, scope, expandedCommonContactIds, selectedIds])

  const clearSelection = () => {
    setSelectedIds(new Set())
    setSelectedCommonKeys(new Set())
  }

  // 스코프 전환 시 선택 초기화 — 서로 다른 단위(id vs email_key) 섞이면 혼란
  const handleScopeChange = (v: ScopeValue) => {
    setScope(v)
    clearSelection()
  }

  const handleEdit = (contact: ContactWithGroups) => {
    setEditContact(contact)
    setFormOpen(true)
    setDetailContactId(null)
  }

  const handleRowClick = (contact: ContactWithGroups) => {
    setDetailContactId(contact.id)
  }

  // 실제 detail contact — 자체 쿼리로 조회 (invalidate 시 자동 refetch → always fresh).
  // 필터된 리스트에서 lookup 하면 sheet 안에서 고객분류/그룹사를 바꾸는 순간
  // 그 행이 현재 필터에서 빠지며 sheet 가 편집 도중 저절로 닫히는 문제가 있었음.
  const { data: detailContact = null } = useContactById(detailContactId)

  const handleDelete = async () => {
    if (deleteTarget) {
      await deleteContacts.mutateAsync([deleteTarget.id])
      setDeleteTarget(null)
    }
  }

  const handleBulkDelete = async () => {
    // 공통 뷰에선 선택된 email_key 의 모든 사본을 한 번에 삭제 — 단,
    // RLS 상 내 것만 실제로 지워지고 남의 것은 조용히 스킵됨.
    const ids =
      scope === 'common' ? expandedCommonContactIds : [...selectedIds]
    await deleteContacts.mutateAsync(ids)
    clearSelection()
    setBulkDeleteOpen(false)
  }

  const handleBulkUnsubscribe = async () => {
    // RPC 단일 호출로 일괄 처리 — RLS 우회 + 다른 owner 행도 처리 (조직 멤버 권한).
    const ids = scope === 'common' ? expandedCommonContactIds : [...selectedIds]
    if (ids.length === 0) return
    await bulkUnsub.mutateAsync({ contactIds: ids, unsubscribe: true })
    clearSelection()
  }

  const handleToggleUnsub = (contact: ContactWithGroups) => {
    toggleUnsub.mutate({ id: contact.id, unsubscribe: !contact.is_unsubscribed })
  }

  // 일괄 AI 그룹사 분석 — 선택된 contact 중 그룹사가 비어있고 이메일 있는 것만.
  // resolveCompaniesBatch 가 (회사명 또는 도메인) 키로 dedupe → 키별 1회만 LLM 호출,
  // 나머지는 company_cache 활용. 1000명이라도 unique 회사명/도메인 수만큼만 과금.
  const [bulkAiPending, setBulkAiPending] = useState(false)
  const handleBulkAiResolve = async () => {
    const idSet = new Set(scope === 'common' ? expandedCommonContactIds : selectedIds)
    const targets = contacts.filter(
      (c) => idSet.has(c.id) && !c.parent_group && c.email,
    )
    if (targets.length === 0) {
      toast.info('AI 분석 대상이 없습니다 — 선택한 연락처에 그룹사가 이미 채워져 있거나 이메일이 없습니다.')
      return
    }
    setBulkAiPending(true)
    toast.info(`AI 그룹사 분석 시작 — ${targets.length}건 (중복 회사/도메인은 캐시 재사용)`)
    try {
      await resolveCompaniesBatch(
        targets.map((c) => ({
          id: c.id,
          rawName: c.company_raw ?? c.company ?? null,
          email: c.email,
        })),
        qc,
        // 선택 대상은 이미 그룹사가 비어있는 것들 — 과거 null 캐시 무시하고 재분석
        { forceRefresh: true },
      )
      toast.success(`AI 그룹사 분석 완료 — ${targets.length}건 처리`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI 분석 중 오류')
    } finally {
      setBulkAiPending(false)
      clearSelection()
    }
  }

  // 빈 그룹사 전체 AI 채우기 — 그룹사가 비어있고 회사명 또는 회사 도메인이 있는 연락처.
  // (회사 신호가 전혀 없는 건 resolveCompaniesBatch 가 내부에서 skip)
  const [fillGroupsOpen, setFillGroupsOpen] = useState(false)
  const [fillGroupsPending, setFillGroupsPending] = useState(false)
  const emptyGroupTargets = useMemo(
    () =>
      allContacts.filter(
        (c) =>
          !c.parent_group &&
          !c.is_bounced &&
          (c.company?.trim() || c.company_raw?.trim() || (c.email?.includes('@') ?? false)),
      ),
    [allContacts],
  )
  const handleFillEmptyGroups = async () => {
    if (emptyGroupTargets.length === 0) {
      toast.info('그룹사가 비어있는 대상이 없습니다.')
      setFillGroupsOpen(false)
      return
    }
    setFillGroupsOpen(false)
    setFillGroupsPending(true)
    toast.info(`AI 그룹사 분석 시작 — ${emptyGroupTargets.length}건 (중복 회사/도메인은 캐시 재사용)`)
    try {
      await resolveCompaniesBatch(
        emptyGroupTargets.map((c) => ({
          id: c.id,
          rawName: c.company_raw ?? c.company ?? null,
          email: c.email,
        })),
        qc,
        // 과거 null 로 캐시된 회사도 개선된 프롬프트로 재분석 (키별 첫 1회만 재과금)
        { forceRefresh: true },
      )
      toast.success(`AI 그룹사 분석 완료 — ${emptyGroupTargets.length}건 처리`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI 분석 중 오류')
    } finally {
      setFillGroupsPending(false)
    }
  }

  const openNewForm = () => {
    setEditContact(null)
    setOcrPrefill(null)
    setFormOpen(true)
  }

  const handleOcrFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const fields = await ocr.mutateAsync(reader.result as string)
        if (Object.keys(fields).length === 0) {
          toast.error('명함에서 추출된 정보가 없습니다.')
          return
        }
        setOcrPrefill(fields)
        setEditContact(null)
        setFormOpen(true)
        toast.success('명함 인식 완료 — 검토 후 저장하세요.')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '명함 인식 실패')
      } finally {
        if (fileRef.current) fileRef.current.value = ''
      }
    }
    reader.readAsDataURL(file)
  }

  // 분류 변경 액션 — common 뷰에서는 expandedCommonContactIds, 일반에서는 selectedIds 사용.
  const handleBulkChangeCustomerType = async (type: CustomerType) => {
    const ids =
      scope === 'common' ? expandedCommonContactIds : [...selectedIds]
    if (ids.length === 0) return
    await bulkUpdateType.mutateAsync({ contactIds: ids, customerType: type })
    clearSelection()
  }

  const handleBulkArchive = async (archive: boolean) => {
    const ids = scope === 'common' ? expandedCommonContactIds : [...selectedIds]
    if (ids.length === 0) return
    await bulkArchive.mutateAsync({ contactIds: ids, archive })
    clearSelection()
  }

  const isArchivedView = status === 'archived'
  const isBouncedView = status === 'bounced'

  const handleBulkClearBounce = async () => {
    const ids = scope === 'common' ? expandedCommonContactIds : [...selectedIds]
    if (ids.length === 0) return
    await clearBounce.mutateAsync(ids)
    clearSelection()
  }

  return (
    <div className="flex flex-col h-full">
      {/* 헤더 */}
      <div className="px-4 sm:px-6 py-4 border-b">
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">연락처</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {scope === 'common'
                ? `고유 이메일 ${displayCount}개`
                : `총 ${displayCount}명`}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleOcrFileChange}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={ocr.isPending}
              title="명함 사진으로 연락처 자동 입력"
            >
              {ocr.isPending ? (
                <Loader2 className="w-4 h-4 sm:mr-1.5 animate-spin" />
              ) : (
                <ScanLine className="w-4 h-4 sm:mr-1.5" />
              )}
              <span className="hidden sm:inline">명함 인식</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => archiveInactive.mutate(365)}
              disabled={archiveInactive.isPending}
              title="1년 이상 메일/응답/노트 활동이 없는 연락처를 보관함으로 이동"
            >
              {archiveInactive.isPending ? (
                <Loader2 className="w-4 h-4 sm:mr-1.5 animate-spin" />
              ) : (
                <Archive className="w-4 h-4 sm:mr-1.5" />
              )}
              <span className="hidden sm:inline">비활성 자동 보관</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFillGroupsOpen(true)}
              disabled={fillGroupsPending}
              title="그룹사가 비어있는 연락처를 AI 로 일괄 분석해 채웁니다"
            >
              {fillGroupsPending ? (
                <Loader2 className="w-4 h-4 sm:mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 sm:mr-1.5" />
              )}
              <span className="hidden sm:inline">빈 그룹사 AI 채우기</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="w-4 h-4 sm:mr-1.5" />
              <span className="hidden sm:inline">가져오기</span>
            </Button>
            <Button size="sm" onClick={openNewForm}>
              <UserPlus className="w-4 h-4 sm:mr-1.5" />
              <span className="hidden sm:inline">연락처 추가</span>
            </Button>
          </div>
        </div>

        {/* 필터 */}
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="이름/이메일/회사/부서/직책 검색 (초성 가능: ㄱㄷ)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={scope} onValueChange={(v) => handleScopeChange(v as ScopeValue)}>
            <SelectTrigger className="h-8 w-28 text-sm" title="범위">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mine">내 것</SelectItem>
              <SelectItem value="org">조직 전체</SelectItem>
              <SelectItem value="common">공통</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as ContactStatus)}>
            <SelectTrigger className="h-8 w-36 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체 (반송 제외)</SelectItem>
              <SelectItem value="normal">정상만</SelectItem>
              <SelectItem value="unsubscribed">수신거부</SelectItem>
              <SelectItem value="bounced">📭 반송 (비활성)</SelectItem>
              {scope !== 'common' && (
                <SelectItem value="needs_verification">⚠️ 회사 확인 필요</SelectItem>
              )}
              {scope !== 'common' && (
                <SelectItem value="archived">📦 보관함 (비활성)</SelectItem>
              )}
            </SelectContent>
          </Select>
          {/* 고객 분류 필터 — common 뷰는 dedup 단위라 분류 매핑이 모호하므로 숨김 */}
          {scope !== 'common' && (
            <Select
              value={customerType}
              onValueChange={(v) => setCustomerType(v as CustomerType | 'all')}
            >
              <SelectTrigger className="h-8 w-36 text-sm" title="고객 분류">
                <SelectValue placeholder="고객 분류" />
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
          )}
          {/* 그룹사 필터 (Phase 9.1) — AI 가 식별한 한국 대기업 계열.
              옵션이 비어 있어도 항상 렌더 — 안 그러면 '그룹 미소속' 선택 시
              dropdown 이 사라져서 다른 값으로 못 바꾸는 stuck 상태가 됨. */}
          {scope !== 'common' && (
            <Select value={parentGroup} onValueChange={(v) => setParentGroup(v)}>
              <SelectTrigger className="h-8 w-36 text-sm" title="그룹사">
                <SelectValue placeholder="그룹사" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">그룹사 전체</SelectItem>
                <SelectItem value="__none__">그룹 미소속 (독립)</SelectItem>
                {parentGroupOptions.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* 테이블 */}
      <div className="flex-1 overflow-auto">
        {scope === 'common' ? (
          !isLoading && filteredCommon.length === 0 ? (
            <EmptyState
              icon={Users}
              title="공통 연락처가 없습니다"
              description="조직 멤버들이 같은 이메일을 등록하면 여기에 묶여서 표시됩니다."
            />
          ) : (
            <CommonContactsTable
              contacts={filteredCommon}
              loading={isLoading}
              selectedKeys={selectedCommonKeys}
              onSelectKey={handleSelectCommonKey}
              onSelectAll={handleSelectAllCommon}
            />
          )
        ) : !isLoading && contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="연락처가 없습니다"
            description={
              scope === 'mine'
                ? '내가 오너인 연락처가 없습니다. 연락처를 추가하거나 CSV/XLSX 파일로 가져오세요.'
                : '조직에 등록된 연락처가 없습니다. 연락처를 추가하거나 CSV/XLSX 파일로 가져오세요.'
            }
            action={{ label: '연락처 추가', onClick: openNewForm }}
          />
        ) : (
          <ContactsTable
            contacts={contacts}
            loading={isLoading}
            selectedIds={selectedIds}
            onSelectId={handleSelectId}
            onSelectAll={handleSelectAll}
            onEdit={handleEdit}
            onDelete={(c) => setDeleteTarget(c)}
            onToggleUnsubscribe={handleToggleUnsub}
            onRowClick={handleRowClick}
            sort={sort}
            onSortChange={setSort}
          />
        )}
      </div>

      {/* 벌크 액션 바 */}
      <BulkActionBar
        selectedCount={activeSelectedCount}
        onClear={clearSelection}
        actions={[
          {
            label: 'AI 개인화 발송',
            icon: <Wand2 className="w-3.5 h-3.5 mr-1" />,
            onClick: () => setPersonalizeOpen(true),
          },
          {
            label: bulkAiPending ? 'AI 분석 중...' : 'AI 그룹사 분석',
            icon: <Sparkles className="w-3.5 h-3.5 mr-1" />,
            onClick: handleBulkAiResolve,
            disabled: bulkAiPending,
          },
          {
            label: '그룹에 추가',
            icon: <FolderPlus className="w-3.5 h-3.5 mr-1" />,
            onClick: () => setAddToGroupOpen(true),
          },
          {
            label: '시퀀스에 등록',
            icon: <Workflow className="w-3.5 h-3.5 mr-1" />,
            onClick: () => setAddToSequenceOpen(true),
          },
          {
            label: '분류 변경',
            node: (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 md:h-7 text-xs rounded-full"
                    disabled={bulkUpdateType.isPending}
                  >
                    <Tag className="w-3.5 h-3.5 mr-1" />
                    분류 변경
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center">
                  {CUSTOMER_TYPE_OPTIONS.map((opt) => (
                    <DropdownMenuItem
                      key={opt.value}
                      onClick={() => handleBulkChangeCustomerType(opt.value)}
                    >
                      {opt.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          },
          {
            label: '수신거부',
            icon: <UserX className="w-3.5 h-3.5 mr-1" />,
            onClick: handleBulkUnsubscribe,
          },
          // 병합 — 개별(org) 스코프에서 2명 이상 선택 시에만 (공통 뷰는 email 단위라 병합 개념이 다름)
          ...(scope !== 'common' && selectedIds.size >= 2
            ? [
                {
                  label: '병합',
                  icon: <Merge className="w-3.5 h-3.5 mr-1" />,
                  onClick: () => setMergeOpen(true),
                },
              ]
            : []),
          ...(isBouncedView
            ? [
                {
                  label: '반송 해제',
                  icon: <RotateCcw className="w-3.5 h-3.5 mr-1" />,
                  onClick: handleBulkClearBounce,
                },
              ]
            : []),
          isArchivedView
            ? {
                label: '복원',
                icon: <ArchiveRestore className="w-3.5 h-3.5 mr-1" />,
                onClick: () => handleBulkArchive(false),
              }
            : {
                label: '보관',
                icon: <Archive className="w-3.5 h-3.5 mr-1" />,
                onClick: () => handleBulkArchive(true),
              },
          {
            label: '삭제',
            icon: <Trash2 className="w-3.5 h-3.5 mr-1" />,
            variant: 'destructive',
            onClick: () => setBulkDeleteOpen(true),
          },
        ]}
      />

      {/* 다이얼로그들 */}
      <ContactFormDialog
        open={formOpen}
        onOpenChange={(v) => {
          setFormOpen(v)
          if (!v) {
            setEditContact(null)
            setOcrPrefill(null)
          }
        }}
        contact={editContact}
        prefill={ocrPrefill ?? undefined}
      />
      <ContactImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <AddToGroupDialog
        open={addToGroupOpen}
        onOpenChange={setAddToGroupOpen}
        contactIds={scope === 'common' ? expandedCommonContactIds : [...selectedIds]}
        onDone={clearSelection}
      />
      <AddToSequenceDialog
        open={addToSequenceOpen}
        onOpenChange={setAddToSequenceOpen}
        contactIds={scope === 'common' ? expandedCommonContactIds : [...selectedIds]}
        onDone={clearSelection}
      />
      <ContactDetailSheet
        contact={detailContact}
        open={!!detailContact}
        onOpenChange={(v) => !v && setDetailContactId(null)}
        onEdit={handleEdit}
        onToggleUnsubscribe={handleToggleUnsub}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="연락처 삭제"
        description={`"${deleteTarget?.name ?? deleteTarget?.email}"을(를) 삭제하시겠습니까?`}
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleteContacts.isPending}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`연락처 ${scope === 'common' ? expandedCommonContactIds.length : selectedIds.size}개 삭제`}
        description="선택한 연락처를 모두 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다."
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={handleBulkDelete}
        loading={deleteContacts.isPending}
      />
      <PersonalizedSendDialog
        open={personalizeOpen}
        onOpenChange={setPersonalizeOpen}
        contacts={personalizeTargets}
      />
      <MergeContactsDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        contacts={mergeCandidates}
        onDone={clearSelection}
      />
      <ConfirmDialog
        open={fillGroupsOpen}
        onOpenChange={setFillGroupsOpen}
        title="빈 그룹사 AI 채우기"
        description={`그룹사가 비어있는 ${emptyGroupTargets.length}명을 AI 로 분석해 채웁니다. 이미 입력된 그룹사는 건드리지 않으며, AI 가 그룹을 못 찾은 연락처는 비워둡니다. 중복 회사·도메인은 캐시를 재사용해 비용을 아낍니다. (분석 중에는 이 창을 열어두세요.)`}
        confirmLabel="분석 시작"
        onConfirm={handleFillEmptyGroups}
      />
    </div>
  )
}
