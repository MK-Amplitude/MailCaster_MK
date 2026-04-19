// CcBccPicker
// ------------------------------------------------------------
// 캠페인 CC / BCC 입력 — 세 가지 소스에서 주소를 모은다:
//   1) 이메일 직접 입력 (칩 Input) — 기존 EmailChipInput 재사용
//   2) 그룹 선택                  — 그룹을 담으면 해당 그룹의 모든 연락처 이메일이 포함
//   3) 개별 연락처 선택           — 특정 contact 만 담기
//
// 상태 구조 (부모가 소유):
//   - emails:     string[]  수동 입력 이메일
//   - groupIds:   string[]  선택된 그룹 ID
//   - contactIds: string[]  선택된 개별 연락처 ID
//
// 최종 이메일 리스트 계산은 부모(campaignWizard) 가 담당한다. 이 컴포넌트는
// 입력만 받고 선택 UI 를 렌더한다. 최종 이메일 수 표기를 위해 부모가 계산한
// `resolvedEmails` (중복 제거된 최종 리스트) 를 주입받는다.
//
// 구조상 RecipientBasket 과 비슷하지만 다음이 다르다:
//   - 제외 명단(excluded) 개념 없음 — CC/BCC 는 이메일 단위라 제외가 무의미
//   - 이메일 직접 입력 섹션이 상단에 존재
//   - 수신거부/반송 연락처는 조용히 스킵 (그룹 펼칠 때 부모 로직에서 제거)
// ------------------------------------------------------------

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Users,
  UserRound,
  Mail,
  Search,
  Plus,
  X,
  Loader2,
  CheckSquare,
  Square,
} from 'lucide-react'
import { EmailChipInput } from '@/components/common/EmailChipInput'
import { matchesSearch } from '@/lib/search'
import { useContacts } from '@/hooks/useContacts'

export interface GroupOpt {
  id: string
  name: string
  color: string | null
  member_count: number
}

export interface ContactLite {
  id: string
  email: string
  name: string | null
}

interface Props {
  /** 'cc' or 'bcc' — 라벨/안내 문구 구분용 */
  kind: 'cc' | 'bcc'
  emails: string[]
  setEmails: (v: string[]) => void
  groups: GroupOpt[]
  groupIds: string[]
  setGroupIds: (v: string[]) => void
  contactIds: string[]
  setContactIds: (v: string[]) => void
  /** 부모가 계산한 최종 dedupe 이메일 리스트 (수신거부/반송 제외 후) */
  resolvedEmails: string[]
  loading?: boolean
  /**
   * 같은 이메일이 이미 To(받는사람)에 들어있을 때 충돌 경고 표시용.
   * Gmail 은 같은 주소가 To + Cc 양쪽에 있으면 내부에서 dedupe 하지만,
   * 사용자에게 "내가 뭘 선택했는지" 를 명확히 알리는 게 좋다.
   */
  recipientEmails?: string[]
}

export function CcBccPicker({
  kind,
  emails,
  setEmails,
  groups,
  groupIds,
  setGroupIds,
  contactIds,
  setContactIds,
  resolvedEmails,
  loading,
  recipientEmails,
}: Props) {
  const recipSet = useMemo(
    () => new Set((recipientEmails ?? []).map((e) => e.trim().toLowerCase())),
    [recipientEmails]
  )
  const overlapWithRecipients = useMemo(
    () => resolvedEmails.filter((e) => recipSet.has(e.trim().toLowerCase())),
    [resolvedEmails, recipSet]
  )

  const directCount = emails.length
  const totalSelected = directCount + groupIds.length + contactIds.length

  return (
    <div className="space-y-3">
      <Tabs defaultValue="emails" className="w-full">
        <TabsList className="h-8">
          <TabsTrigger value="emails" className="text-xs h-7 gap-1">
            <Mail className="w-3.5 h-3.5" />
            직접 입력 ({directCount})
          </TabsTrigger>
          <TabsTrigger value="groups" className="text-xs h-7 gap-1">
            <Users className="w-3.5 h-3.5" />
            그룹 ({groupIds.length})
          </TabsTrigger>
          <TabsTrigger value="contacts" className="text-xs h-7 gap-1">
            <UserRound className="w-3.5 h-3.5" />
            개별 연락처 ({contactIds.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="emails" className="mt-3">
          <EmailChipInput
            value={emails}
            onChange={setEmails}
            placeholder={
              kind === 'cc'
                ? '예: manager@company.com (Enter/콤마로 추가)'
                : '예: archive@company.com (Enter/콤마로 추가)'
            }
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            자유롭게 이메일 주소를 입력합니다. 그룹/개별 연락처와 함께 쓰면 자동으로 중복이 제거됩니다.
          </p>
        </TabsContent>

        <TabsContent value="groups" className="mt-3">
          <GroupTab
            groups={groups}
            selectedGroupIds={groupIds}
            setSelectedGroupIds={setGroupIds}
          />
        </TabsContent>

        <TabsContent value="contacts" className="mt-3">
          <ContactTab
            selectedContactIds={contactIds}
            setSelectedContactIds={setContactIds}
          />
        </TabsContent>
      </Tabs>

      {totalSelected > 0 && (
        <SelectedSummary
          kind={kind}
          emails={emails}
          setEmails={setEmails}
          groups={groups}
          groupIds={groupIds}
          setGroupIds={setGroupIds}
          contactIds={contactIds}
          setContactIds={setContactIds}
          resolvedEmails={resolvedEmails}
          loading={loading}
          overlapWithRecipients={overlapWithRecipients}
        />
      )}
    </div>
  )
}

// ============================================================
// 그룹 탭 — RecipientBasket 과 거의 동일 (검색 + 체크박스)
// ============================================================
function GroupTab({
  groups,
  selectedGroupIds,
  setSelectedGroupIds,
}: {
  groups: GroupOpt[]
  selectedGroupIds: string[]
  setSelectedGroupIds: (ids: string[]) => void
}) {
  const [search, setSearch] = useState('')

  const toggle = (id: string) =>
    setSelectedGroupIds(
      selectedGroupIds.includes(id)
        ? selectedGroupIds.filter((g) => g !== id)
        : [...selectedGroupIds, id]
    )

  const filtered = useMemo(() => {
    const q = search.trim()
    if (!q) return groups
    return groups.filter((g) => matchesSearch(g.name, q))
  }, [groups, search])

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          그룹이 없습니다. 그룹 페이지에서 먼저 만들어주세요.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          className="pl-8 h-8 text-sm"
          placeholder="그룹 이름 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-center text-xs text-muted-foreground py-6">
          "{search}" 에 해당하는 그룹이 없습니다.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filtered.map((g) => {
            const checked = selectedGroupIds.includes(g.id)
            return (
              <Card
                key={g.id}
                className={`cursor-pointer transition-colors ${checked ? 'border-primary bg-primary/5' : ''}`}
                onClick={() => toggle(g.id)}
              >
                <CardContent className="p-3 flex items-center gap-3">
                  <Checkbox checked={checked} />
                  <div
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: g.color ?? '#9ca3af' }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{g.name}</div>
                    <div className="text-xs text-muted-foreground">{g.member_count}명</div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ============================================================
// 개별 연락처 탭 — 검색 + 스테이징 + 바구니에 추가
// ============================================================
function ContactTab({
  selectedContactIds,
  setSelectedContactIds,
}: {
  selectedContactIds: string[]
  setSelectedContactIds: (ids: string[]) => void
}) {
  const { data: allContacts = [], isLoading } = useContacts({ status: 'normal' })
  const [search, setSearch] = useState('')
  const [stagingIds, setStagingIds] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const q = search.trim()
    if (!q) return allContacts
    return allContacts.filter((c) =>
      matchesSearch(c.email, q) ||
      matchesSearch(c.name, q) ||
      matchesSearch(c.company, q) ||
      matchesSearch(c.department, q) ||
      matchesSearch(c.job_title, q)
    )
  }, [allContacts, search])

  const alreadyInBasket = useMemo(
    () => new Set(selectedContactIds),
    [selectedContactIds]
  )

  const selectableIds = useMemo(
    () => filtered.filter((c) => !alreadyInBasket.has(c.id)).map((c) => c.id),
    [filtered, alreadyInBasket]
  )

  const allSelectableChecked =
    selectableIds.length > 0 && selectableIds.every((id) => stagingIds.has(id))
  const someSelectableChecked =
    selectableIds.some((id) => stagingIds.has(id))

  const toggleOne = (id: string) => {
    setStagingIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setStagingIds((prev) => {
      const next = new Set(prev)
      if (allSelectableChecked) {
        for (const id of selectableIds) next.delete(id)
      } else {
        for (const id of selectableIds) next.add(id)
      }
      return next
    })
  }

  const addToBasket = () => {
    const toAdd = Array.from(stagingIds).filter((id) => !alreadyInBasket.has(id))
    if (toAdd.length === 0) return
    setSelectedContactIds([...selectedContactIds, ...toAdd])
    setStagingIds(new Set())
  }

  const stagingCount = Array.from(stagingIds).filter((id) => !alreadyInBasket.has(id)).length

  return (
    <Card>
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="이메일·이름·회사·부서·직급 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-xs shrink-0"
            onClick={toggleAll}
            disabled={selectableIds.length === 0}
            title={allSelectableChecked ? '선택 해제' : '검색 결과 전체 선택'}
          >
            {allSelectableChecked ? (
              <CheckSquare className="w-3.5 h-3.5 mr-1" />
            ) : someSelectableChecked ? (
              <CheckSquare className="w-3.5 h-3.5 mr-1 opacity-60" />
            ) : (
              <Square className="w-3.5 h-3.5 mr-1" />
            )}
            {allSelectableChecked ? '해제' : `전체 (${selectableIds.length})`}
          </Button>
          <Button
            size="sm"
            onClick={addToBasket}
            disabled={stagingCount === 0}
            className="h-8 px-2 text-xs shrink-0"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            바구니에 추가 {stagingCount > 0 && `(${stagingCount})`}
          </Button>
        </div>

        <div className="border rounded max-h-64 overflow-y-auto">
          {isLoading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
              연락처 불러오는 중…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {search ? '검색 결과가 없습니다.' : '연락처가 없습니다.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground bg-muted/30 sticky top-0">
                <tr>
                  <th className="w-8 text-left px-2 py-1.5"></th>
                  <th className="text-left px-2 py-1.5 font-medium">이메일</th>
                  <th className="text-left px-2 py-1.5 font-medium">이름</th>
                  <th className="text-left px-2 py-1.5 font-medium">회사</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const inBasket = alreadyInBasket.has(c.id)
                  const staged = stagingIds.has(c.id)
                  return (
                    <tr
                      key={c.id}
                      className={`border-t ${inBasket ? 'bg-muted/30' : 'hover:bg-muted/20 cursor-pointer'}`}
                      onClick={() => !inBasket && toggleOne(c.id)}
                    >
                      <td className="px-2 py-1.5">
                        <Checkbox
                          checked={inBasket || staged}
                          disabled={inBasket}
                          onCheckedChange={() => toggleOne(c.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2 py-1.5 truncate max-w-[200px]">
                        {c.email}
                        {inBasket && (
                          <Badge variant="secondary" className="ml-2 text-[10px]">
                            담김
                          </Badge>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{c.name ?? '-'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground truncate max-w-[140px]">
                        {c.company ?? '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================
// 선택 요약 — 담긴 이메일/그룹/개별 연락처 + 최종 이메일 수 + 충돌 경고
// ============================================================
function SelectedSummary({
  kind,
  emails,
  setEmails,
  groups,
  groupIds,
  setGroupIds,
  contactIds,
  setContactIds,
  resolvedEmails,
  loading,
  overlapWithRecipients,
}: {
  kind: 'cc' | 'bcc'
  emails: string[]
  setEmails: (v: string[]) => void
  groups: GroupOpt[]
  groupIds: string[]
  setGroupIds: (v: string[]) => void
  contactIds: string[]
  setContactIds: (v: string[]) => void
  resolvedEmails: string[]
  loading?: boolean
  overlapWithRecipients: string[]
}) {
  const selectedGroups = useMemo(
    () => groups.filter((g) => groupIds.includes(g.id)),
    [groups, groupIds]
  )

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs text-muted-foreground">
            최종 {kind === 'cc' ? 'Cc' : 'Bcc'} 이메일
          </span>
          {loading ? (
            <Badge variant="secondary" className="text-xs">
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              계산 중
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs">
              {resolvedEmails.length}개
            </Badge>
          )}
        </div>

        {emails.length > 0 && (
          <ChipRow
            label={`직접 입력 ${emails.length}`}
            items={emails.map((e, i) => ({ id: `direct-${i}`, label: e }))}
            onRemove={(id) => {
              const idx = Number(id.replace('direct-', ''))
              if (Number.isNaN(idx)) return
              setEmails(emails.filter((_, i) => i !== idx))
            }}
          />
        )}

        {selectedGroups.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <span className="text-[11px] text-muted-foreground mr-1 self-center">
              그룹 {selectedGroups.length}:
            </span>
            {selectedGroups.map((g) => (
              <Badge
                key={g.id}
                variant="secondary"
                className="text-xs pl-1.5 pr-0.5 py-0 flex items-center gap-1"
              >
                <span
                  className="w-1.5 h-1.5 rounded-full inline-block"
                  style={{ backgroundColor: g.color ?? '#9ca3af' }}
                />
                <span>{g.name}</span>
                <span className="text-muted-foreground">({g.member_count})</span>
                <button
                  type="button"
                  className="ml-0.5 hover:text-destructive rounded p-0.5"
                  onClick={() => setGroupIds(groupIds.filter((id) => id !== g.id))}
                  aria-label={`${g.name} 그룹 제거`}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        {contactIds.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              개별 연락처 {contactIds.length}명
            </span>
            <button
              type="button"
              className="text-[11px] text-destructive hover:underline"
              onClick={() => setContactIds([])}
            >
              전체 제거
            </button>
          </div>
        )}

        {overlapWithRecipients.length > 0 && (
          <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50/60 dark:bg-amber-950/20 rounded p-1.5">
            ⚠️ {kind === 'cc' ? 'Cc' : 'Bcc'} 주소 중 {overlapWithRecipients.length}개가 받는사람(To)과 겹칩니다. Gmail 에서 자동으로 중복이 제거되지만, 의도한 구성인지 확인해주세요.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------
// 공용 칩 행 — 단순한 on × 목록
// ------------------------------------------------------------
function ChipRow({
  label,
  items,
  onRemove,
}: {
  label: string
  items: Array<{ id: string; label: string }>
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <span className="text-[11px] text-muted-foreground mr-1 self-center">{label}:</span>
      {items.map((it) => (
        <Badge
          key={it.id}
          variant="outline"
          className="text-[11px] pl-1.5 pr-0.5 py-0 flex items-center gap-1"
        >
          <span className="truncate max-w-[180px]">{it.label}</span>
          <button
            type="button"
            className="ml-0.5 hover:text-destructive rounded p-0.5"
            onClick={() => onRemove(it.id)}
            aria-label={`${it.label} 제거`}
          >
            <X className="w-3 h-3" />
          </button>
        </Badge>
      ))}
    </div>
  )
}
