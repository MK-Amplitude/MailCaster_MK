import { useEffect, useMemo, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Pencil, UserX, UserCheck, Building2, Phone, Clock, FileText, Sparkles, User, History, Tag, Network, Plus, X, FolderPlus, Search } from 'lucide-react'
import {
  CUSTOMER_TYPE_OPTIONS,
  type ContactWithGroups,
  type CustomerType,
  type ContactGroupInfo,
} from '@/types/contact'
import { formatDateTime, cn } from '@/lib/utils'
import { useContactHistory } from '@/hooks/useContactHistory'
import type { ContactHistoryRow } from '@/hooks/useContactHistory'
import { useAuth } from '@/hooks/useAuth'
import { useUpdateContact, useParentGroupOptions } from '@/hooks/useContacts'
import { useGroups, useAddMemberToGroup, useRemoveMemberFromGroup } from '@/hooks/useGroups'
import { matchesSearch } from '@/lib/search'

interface ContactDetailSheetProps {
  contact: ContactWithGroups | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: (contact: ContactWithGroups) => void
  onToggleUnsubscribe: (contact: ContactWithGroups) => void
}

export function ContactDetailSheet({
  contact,
  open,
  onOpenChange,
  onEdit,
  onToggleUnsubscribe,
}: ContactDetailSheetProps) {
  const { data: history = [] } = useContactHistory(contact?.id)
  const { user, isOrgAdmin } = useAuth()
  const updateContact = useUpdateContact()
  // 오너 또는 org admin 만 수정/수신거부 토글 가능 — RLS 와 일치
  const canMutate = !!contact && (contact.user_id === user?.id || isOrgAdmin)

  const handleCustomerTypeChange = (value: CustomerType) => {
    if (!contact || value === (contact.customer_type ?? 'general')) return
    updateContact.mutate({ id: contact.id, data: { customer_type: value } })
  }

  if (!contact) return null

  const currentType = (contact.customer_type as CustomerType | null) ?? 'general'
  const currentTypeOpt = CUSTOMER_TYPE_OPTIONS.find((o) => o.value === currentType)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-5 py-4 border-b">
          <SheetTitle className="text-left">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">
                    {contact.name ?? '이름 없음'}
                  </span>
                  <StatusBadge
                    isUnsubscribed={contact.is_unsubscribed}
                    isBounced={contact.is_bounced}
                  />
                </div>
                <p className="text-sm text-muted-foreground font-normal mt-0.5">
                  {contact.email}
                </p>
              </div>
              {canMutate && (
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => onEdit(contact)}
                    title="수정"
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => onToggleUnsubscribe(contact)}
                    title={contact.is_unsubscribed ? '수신거부 해제' : '수신거부'}
                  >
                    {contact.is_unsubscribed ? (
                      <UserCheck className="w-4 h-4" />
                    ) : (
                      <UserX className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-5">
            {/* 기본 정보 */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                기본 정보
              </h3>
              {/* 고객 분류 — 인라인 즉시 편집 (저장 후 토스트 표시됨) */}
              <InfoRow icon={Tag} label="고객 분류">
                {canMutate ? (
                  <Select
                    value={currentType}
                    onValueChange={(v) => handleCustomerTypeChange(v as CustomerType)}
                    disabled={updateContact.isPending}
                  >
                    <SelectTrigger
                      className={cn(
                        'h-7 w-fit min-w-[140px] text-xs gap-1.5 px-2 border',
                        currentTypeOpt?.className
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CUSTOMER_TYPE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge
                    variant="outline"
                    className={cn('text-xs border', currentTypeOpt?.className)}
                  >
                    {currentTypeOpt?.label ?? '일반'}
                  </Badge>
                )}
              </InfoRow>
              {contact.company && (
                <InfoRow icon={Building2} label="회사 (입력값)">
                  <span>{contact.company}</span>
                  {contact.department && (
                    <span className="text-muted-foreground"> · {contact.department}</span>
                  )}
                </InfoRow>
              )}
              {(contact.company_ko || contact.company_en) && (
                <InfoRow icon={Sparkles} label="공식 명칭 (AI)">
                  <div className="space-y-0.5">
                    {contact.company_ko && (
                      <div>
                        <span className="text-[10px] text-muted-foreground mr-1">KO</span>
                        {contact.company_ko}
                      </div>
                    )}
                    {contact.company_en && (
                      <div>
                        <span className="text-[10px] text-muted-foreground mr-1">EN</span>
                        {contact.company_en}
                      </div>
                    )}
                  </div>
                </InfoRow>
              )}
              {/* 그룹사 — AI 자동 식별 + 사용자 수동 편집 (combobox: 기존 옵션 선택 또는 직접 입력) */}
              {(canMutate || contact.parent_group) && (
                <InfoRow icon={Network} label="그룹사">
                  <ParentGroupEditor contact={contact} canMutate={canMutate} />
                </InfoRow>
              )}
              {contact.job_title && (
                <InfoRow icon={FileText} label="직책">
                  {contact.job_title}
                </InfoRow>
              )}
              {contact.phone && (
                <InfoRow icon={Phone} label="전화">
                  {contact.phone}
                </InfoRow>
              )}
              <InfoRow icon={Clock} label="등록일">
                {formatDateTime(contact.created_at)}
              </InfoRow>
              {(contact.owner_name || contact.owner_email) && (
                <InfoRow icon={User} label="소유자">
                  <div>
                    {contact.owner_name ?? contact.owner_email}
                    {contact.owner_name && contact.owner_email && (
                      <span className="text-xs text-muted-foreground ml-1">
                        ({contact.owner_email})
                      </span>
                    )}
                  </div>
                </InfoRow>
              )}
            </section>

            <Separator />

            {/* 소속 그룹 — 인라인 추가/제거 */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                소속 그룹
              </h3>
              <ContactGroupsEditor contact={contact} canMutate={canMutate} />
            </section>

            {/* 메모 */}
            {contact.memo && (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    메모
                  </h3>
                  <p className="text-sm whitespace-pre-wrap">{contact.memo}</p>
                </section>
              </>
            )}

            {/* 커스텀 변수 */}
            {contact.variables && Object.keys(contact.variables as object).length > 0 && (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    커스텀 변수
                  </h3>
                  <div className="space-y-1.5">
                    {Object.entries(contact.variables as Record<string, string>).map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-sm">
                        <span className="font-medium min-w-[80px] text-muted-foreground">
                          {k}
                        </span>
                        <span>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {/* 변경 이력 */}
            {history.length > 0 && (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                    <History className="w-3 h-3" />
                    변경 이력
                  </h3>
                  <div className="space-y-2">
                    {history.map((h) => (
                      <HistoryEntry key={h.id} row={h} />
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

// 소속 그룹 인라인 편집기:
//   - 기존 멤버십을 모두 뱃지로 표시 + canMutate 면 X 클릭으로 제거
//   - "+ 추가" Popover: 검색 가능한 미가입 그룹 리스트, 클릭 시 즉시 추가
function ContactGroupsEditor({
  contact,
  canMutate,
}: {
  contact: ContactWithGroups
  canMutate: boolean
}) {
  const { data: allGroups = [] } = useGroups()
  const addMember = useAddMemberToGroup()
  const removeMember = useRemoveMemberFromGroup()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [search, setSearch] = useState('')

  // 이미 가입된 그룹 id set — 추가 picker 에서 필터링
  const memberGroupIds = useMemo(
    () => new Set(contact.groups.map((g) => g.group_id)),
    [contact.groups]
  )

  // 추가 가능한 그룹 = 전체 그룹 - 이미 멤버인 그룹. 검색어로 추가 필터.
  const addableGroups = useMemo(() => {
    const q = search.trim()
    return allGroups
      .filter((g) => !memberGroupIds.has(g.id))
      .filter((g) => {
        if (!q) return true
        const cat = g.group_categories?.name ?? ''
        return matchesSearch(g.name, q) || matchesSearch(cat, q)
      })
  }, [allGroups, memberGroupIds, search])

  const handleAdd = async (groupId: string) => {
    await addMember.mutateAsync({ contactId: contact.id, groupId })
    // 같은 popover 안에서 연속 추가가 일반적 — 닫지 않고 검색만 초기화
    setSearch('')
  }

  const handleRemove = (groupId: string) => {
    removeMember.mutate({ contactId: contact.id, groupId })
  }

  if (contact.groups.length === 0 && !canMutate) {
    return <p className="text-sm text-muted-foreground">소속 그룹 없음</p>
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {contact.groups.length === 0 && canMutate && (
        <span className="text-sm text-muted-foreground">소속 그룹 없음 —</span>
      )}
      {contact.groups.map((g: ContactGroupInfo) => (
        <Badge
          key={g.group_id}
          variant="outline"
          className="text-xs gap-1 pr-1"
          style={
            g.category_color
              ? { borderColor: g.category_color, color: g.category_color }
              : undefined
          }
        >
          {g.category_name && (
            <span className="opacity-60">{g.category_name} /</span>
          )}
          {g.group_name}
          {canMutate && (
            <button
              type="button"
              onClick={() => handleRemove(g.group_id)}
              disabled={removeMember.isPending}
              className="ml-0.5 -mr-0.5 rounded-sm hover:bg-foreground/10 transition-colors p-0.5"
              aria-label={`${g.group_name} 그룹에서 제거`}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </Badge>
      ))}

      {canMutate && (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 text-xs gap-1 px-2"
            >
              <Plus className="w-3 h-3" />
              그룹 추가
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="start">
            <div className="px-3 py-2 border-b">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  className="pl-7 h-7 text-xs"
                  placeholder="그룹/카테고리 검색"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {allGroups.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  <FolderPlus className="w-5 h-5 mx-auto mb-1 opacity-50" />
                  먼저 그룹 페이지에서 그룹을 만들어주세요.
                </div>
              ) : addableGroups.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {search.trim()
                    ? '검색 결과 없음.'
                    : '추가 가능한 그룹이 없습니다 (모두 가입됨).'}
                </div>
              ) : (
                addableGroups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => handleAdd(g.id)}
                    disabled={addMember.isPending}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent disabled:opacity-50 transition-colors"
                  >
                    {g.group_categories?.color && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: g.group_categories.color }}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{g.name}</div>
                      {g.group_categories?.name && (
                        <div className="text-[10px] text-muted-foreground truncate">
                          {g.group_categories.name}
                        </div>
                      )}
                    </div>
                    <Plus className="w-3 h-3 text-muted-foreground" />
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

// 그룹사 인라인 편집기 — datalist 로 기존 그룹사를 자동완성 + 자유 입력 둘 다 지원.
// blur 또는 Enter 시 저장, Esc 취소.
function ParentGroupEditor({
  contact,
  canMutate,
}: {
  contact: ContactWithGroups
  canMutate: boolean
}) {
  const updateContact = useUpdateContact()
  const { data: options = [] } = useParentGroupOptions()
  const [value, setValue] = useState(contact.parent_group ?? '')

  // 다른 contact 로 전환되거나 외부에서 값이 바뀌면 동기화
  useEffect(() => {
    setValue(contact.parent_group ?? '')
  }, [contact.id, contact.parent_group])

  const save = () => {
    const trimmed = value.trim()
    const newValue = trimmed === '' ? null : trimmed
    if (newValue === (contact.parent_group ?? null)) return
    updateContact.mutate({ id: contact.id, data: { parent_group: newValue } })
  }

  if (!canMutate) {
    return contact.parent_group ? (
      <Badge
        variant="outline"
        className="text-xs border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 bg-violet-50/60 dark:bg-violet-900/20"
      >
        {contact.parent_group}
      </Badge>
    ) : (
      <span className="text-xs text-muted-foreground">-</span>
    )
  }

  // datalist id 는 contact 마다 unique 해야 함 — 같은 페이지에 여러 detail sheet 가 떠도 충돌 없음
  const listId = `parent-group-options-${contact.id}`

  return (
    <div className="flex flex-col gap-1 w-full">
      <Input
        list={listId}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.currentTarget as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            setValue(contact.parent_group ?? '')
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
        placeholder="예: 롯데, 카카오, 또는 직접 입력"
        className="h-8 text-xs"
        disabled={updateContact.isPending}
      />
      <datalist id={listId}>
        {options.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <p className="text-[10px] text-muted-foreground">
        목록에서 선택하거나 새 그룹명을 직접 입력. Enter 또는 다른 곳 클릭 시 저장.
      </p>
    </div>
  )
}

function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ElementType
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
      <div>
        <span className="text-muted-foreground text-xs block">{label}</span>
        <div className="text-foreground">{children}</div>
      </div>
    </div>
  )
}

const FIELD_LABELS: Record<string, string> = {
  email: '이메일',
  name: '이름',
  company: '회사',
  company_raw: '회사(원본)',
  company_ko: '회사(한글)',
  company_en: '회사(영문)',
  department: '부서',
  job_title: '직책',
  phone: '전화번호',
  memo: '메모',
  customer_type: '고객 분류',
  parent_group: '그룹사',
}

function HistoryEntry({ row }: { row: ContactHistoryRow }) {
  const snapshot = row.snapshot as Record<string, unknown>
  return (
    <div className="rounded border p-2.5 text-xs bg-muted/30">
      <div className="flex items-center justify-between mb-1.5">
        <Badge
          variant="secondary"
          className="text-[10px] py-0 px-1.5"
        >
          {row.action === 'create' ? '생성' : '수정'}
        </Badge>
        <span className="text-muted-foreground">{formatDateTime(row.changed_at)}</span>
      </div>
      {row.action === 'update' && row.changed_fields.length > 0 && (
        <div className="space-y-0.5">
          {row.changed_fields.map((field) => {
            const oldValue = snapshot[field]
            const label = FIELD_LABELS[field] ?? field
            return (
              <div key={field} className="flex gap-1.5">
                <span className="text-muted-foreground min-w-[60px]">{label}</span>
                <span className="line-through text-muted-foreground truncate">
                  {oldValue == null || oldValue === '' ? '-' : String(oldValue)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
