// RecipientBasket
// ------------------------------------------------------------
// 캠페인 Step1 의 수신자 선택을 담당하는 "바구니" 패턴 컴포넌트.
//
//   [탭] 그룹  |  개별 연락처
//     └─ 그룹 탭:     검색 Input + 체크박스 리스트
//     └─ 연락처 탭:   검색 Input + 연락처 테이블 + "필터 결과 전체 선택"
//        + "바구니에 추가" 버튼
//
//   [바구니]  선택된 그룹 / 개별 연락처 / 최종 수신자 수 (이메일 중복 제거)
//     └─ 제거 버튼 (그룹 / 개별 각각)
//     └─ 미리보기 행의 × — 개별 수신자 제외 (excludedContactIds)
//     └─ "제외된 수신자" 칩 섹션 — 해제 버튼 포함
//
// 부모가 들고 있는 것:
//   - selectedGroupIds: string[]        — 바구니에 담긴 그룹
//   - selectedContactIds: string[]      — 바구니에 담긴 개별 연락처
//   - excludedContactIds: string[]      — Phase 6 (B) — 제외 수신자 (campaign_exclusions)
//   - previewContacts: PreviewContact[] — 최종 union+dedupe−exclude 결과 (수신거부/반송 제외)
//   - excludedMeta: PreviewContact[]    — 제외 명단의 메타 (칩 표시용)
//     → 이 결과 계산은 부모에서 수행 (DB 쿼리 필요). 이 컴포넌트는 렌더만 담당.
//
// 중복/제외 규칙 (부모 책임):
//   - 같은 이메일이 그룹 + 개별에서 둘 다 들어와도 recipients 에는 1회만
//   - 그룹과 개별 사이에서도 dedupe
//   - 수신거부(is_unsubscribed) / 반송(is_bounced) 연락처는 제외
//   - excludedContactIds 에 속한 contact 는 preview 에서도 제외
// ------------------------------------------------------------

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Users,
  UserRound,
  Search,
  Plus,
  X,
  Loader2,
  CheckSquare,
  Square,
} from 'lucide-react'
import { matchesSearch } from '@/lib/search'
import { useContacts } from '@/hooks/useContacts'

export interface GroupOpt {
  id: string
  name: string
  color: string | null
  member_count: number
}

export interface PreviewContact {
  id: string
  email: string
  name: string | null
  company: string | null
  department: string | null
  job_title: string | null
}

interface Props {
  groups: GroupOpt[]
  selectedGroupIds: string[]
  setSelectedGroupIds: (ids: string[]) => void
  selectedContactIds: string[]
  setSelectedContactIds: (ids: string[]) => void
  /** 부모가 계산한 최종 union+dedupe−exclude 수신자 (수신거부/반송 + 제외 명단 제외) */
  previewContacts: PreviewContact[]
  loadingPreview: boolean
  /** Phase 6 (B) — 캠페인 단위 제외 명단. contact_id 기준. */
  excludedContactIds: string[]
  setExcludedContactIds: (ids: string[]) => void
  /** 제외 칩 라벨용 메타 (이메일/이름). 부모가 rawUnion 에서 필터링해서 내려줌. */
  excludedMeta: PreviewContact[]
}

export function RecipientBasket({
  groups,
  selectedGroupIds,
  setSelectedGroupIds,
  selectedContactIds,
  setSelectedContactIds,
  previewContacts,
  loadingPreview,
  excludedContactIds,
  setExcludedContactIds,
  excludedMeta,
}: Props) {
  return (
    <div className="space-y-3">
      <Tabs defaultValue="groups" className="w-full">
        <TabsList className="h-8">
          <TabsTrigger value="groups" className="text-xs h-7 gap-1">
            <Users className="w-3.5 h-3.5" />
            그룹 ({selectedGroupIds.length})
          </TabsTrigger>
          <TabsTrigger value="contacts" className="text-xs h-7 gap-1">
            <UserRound className="w-3.5 h-3.5" />
            개별 연락처 ({selectedContactIds.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="groups" className="mt-3">
          <GroupTab
            groups={groups}
            selectedGroupIds={selectedGroupIds}
            setSelectedGroupIds={setSelectedGroupIds}
          />
        </TabsContent>

        <TabsContent value="contacts" className="mt-3">
          <ContactTab
            selectedContactIds={selectedContactIds}
            setSelectedContactIds={setSelectedContactIds}
          />
        </TabsContent>
      </Tabs>

      {/* 선택 요약 */}
      <SelectedSummary
        groups={groups}
        selectedGroupIds={selectedGroupIds}
        setSelectedGroupIds={setSelectedGroupIds}
        selectedContactIds={selectedContactIds}
        setSelectedContactIds={setSelectedContactIds}
        previewContacts={previewContacts}
        loadingPreview={loadingPreview}
        excludedContactIds={excludedContactIds}
        setExcludedContactIds={setExcludedContactIds}
        excludedMeta={excludedMeta}
      />
    </div>
  )
}

// ============================================================
// 그룹 탭 — 검색 + 선택
// ============================================================
// 그룹이 20~30개 넘어가면 스크롤만으로 찾기 힘드므로 이름 검색 입력 추가.
// 검색 상태는 이 컴포넌트 로컬에만 보관 — 탭 전환해도 유지되도록 굳이 부모에 올리지 않음.
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
          그룹이 없습니다. 그룹 페이지에서 먼저 만들어주세요. (또는 아래 "개별 연락처" 탭에서 직접 선택)
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      {/* 검색 입력 — 그룹 수가 많을 때만 의미있지만 항상 노출해도 가볍다 */}
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

      <div className="text-[11px] text-muted-foreground">
        {search
          ? `${filtered.length} / ${groups.length} 그룹`
          : `총 ${groups.length} 그룹`}
        {' · '}
        {selectedGroupIds.length > 0 && (
          <span className="text-primary">{selectedGroupIds.length}개 선택</span>
        )}
      </div>
    </div>
  )
}

// ============================================================
// 개별 연락처 탭 — 검색 + 필터 결과 일괄 선택
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
  // 검색 결과 안에서 "체크박스로 고른" 임시 선택 — "바구니에 추가" 누르기 전까지 부모 state 와 분리
  const [stagingIds, setStagingIds] = useState<Set<string>>(new Set())

  // 검색 매칭: 이메일 / 이름 / 회사 / 부서 / 직급 어느 하나라도 맞으면
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

  // 이미 부모(바구니) 에 들어간 연락처는 체크박스를 disabled + 체크된 상태로 표시
  const alreadyInBasket = useMemo(
    () => new Set(selectedContactIds),
    [selectedContactIds]
  )

  // 현재 필터 결과 중 "아직 바구니에 없는" 것들의 id 집합
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
        {/* 검색 + 일괄 선택 헤더 */}
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

        {/* 리스트 */}
        <div className="border rounded max-h-80 overflow-y-auto">
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

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {filtered.length}명 표시 (정상 상태만 · 수신거부/반송 제외)
          </span>
          {stagingCount > 0 && (
            <span className="text-primary font-medium">{stagingCount}명 선택됨</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================
// 선택 요약 — 바구니 상태 + 최종 수신자 수 + 제외 명단
// ============================================================
function SelectedSummary({
  groups,
  selectedGroupIds,
  setSelectedGroupIds,
  selectedContactIds,
  setSelectedContactIds,
  previewContacts,
  loadingPreview,
  excludedContactIds,
  setExcludedContactIds,
  excludedMeta,
}: {
  groups: GroupOpt[]
  selectedGroupIds: string[]
  setSelectedGroupIds: (ids: string[]) => void
  selectedContactIds: string[]
  setSelectedContactIds: (ids: string[]) => void
  previewContacts: PreviewContact[]
  loadingPreview: boolean
  excludedContactIds: string[]
  setExcludedContactIds: (ids: string[]) => void
  excludedMeta: PreviewContact[]
}) {
  const selectedGroups = useMemo(
    () => groups.filter((g) => selectedGroupIds.includes(g.id)),
    [groups, selectedGroupIds]
  )
  // 개별 추가 연락처의 메타 정보 — previewContacts 에 이미 join 되어 있음 (contact_id 기준)
  const individualMeta = useMemo(() => {
    const selected = new Set(selectedContactIds)
    return previewContacts.filter((c) => selected.has(c.id))
  }, [selectedContactIds, previewContacts])

  const excludeOne = (id: string) => {
    if (!id) return // 빈 id(재발송 모드 fixedRecipient 등)는 제외 대상 아님
    if (excludedContactIds.includes(id)) return
    setExcludedContactIds([...excludedContactIds, id])
  }
  const restoreExclusion = (id: string) =>
    setExcludedContactIds(excludedContactIds.filter((x) => x !== id))

  const nothing = selectedGroupIds.length === 0 && selectedContactIds.length === 0
  if (nothing) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 text-center text-xs text-muted-foreground">
          위의 탭에서 그룹 또는 개별 연락처를 바구니에 담아주세요.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs">바구니 / 최종 수신자</Label>
          {loadingPreview ? (
            <Badge variant="secondary" className="text-xs">
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              계산 중
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs">
              {previewContacts.length}명
              {excludedContactIds.length > 0 &&
                ` · ${excludedContactIds.length}명 제외`}
            </Badge>
          )}
        </div>

        {/* 그룹 칩 */}
        {selectedGroups.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
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
                  onClick={() =>
                    setSelectedGroupIds(selectedGroupIds.filter((id) => id !== g.id))
                  }
                  aria-label={`${g.name} 그룹 제거`}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        {/* 개별 연락처 칩 — 너무 많으면 접어둠 */}
        {selectedContactIds.length > 0 && (
          <IndividualContactsPanel
            ids={selectedContactIds}
            meta={individualMeta}
            onRemove={(id) =>
              setSelectedContactIds(selectedContactIds.filter((x) => x !== id))
            }
            onClear={() => setSelectedContactIds([])}
          />
        )}

        {/* 제외된 수신자 — 개별 contact 를 최종 수신자 집합에서 빼기 */}
        {excludedMeta.length > 0 && (
          <ExcludedContactsPanel
            meta={excludedMeta}
            onRestore={restoreExclusion}
            onClearAll={() => setExcludedContactIds([])}
          />
        )}

        {/* 상단 10명 미리보기 — × 로 개별 제외 가능 */}
        {previewContacts.length > 0 && (
          <div className="border-t pt-2">
            <div className="text-[11px] text-muted-foreground mb-1">
              미리보기 (상위 10명)
              <span className="ml-1 text-muted-foreground/70">— × 눌러 개별 제외</span>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-0.5">
              {previewContacts.slice(0, 10).map((c) => (
                <div
                  key={c.id || c.email}
                  className="text-xs flex items-center gap-2 group hover:bg-muted/40 rounded px-1 -mx-1"
                >
                  <span className="text-muted-foreground truncate flex-1">{c.email}</span>
                  {c.name && (
                    <span className="text-muted-foreground shrink-0">· {c.name}</span>
                  )}
                  {c.id && (
                    <button
                      type="button"
                      className="opacity-40 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-0.5 shrink-0"
                      onClick={() => excludeOne(c.id)}
                      title="이 수신자 제외"
                      aria-label={`${c.email} 제외`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
              {previewContacts.length > 10 && (
                <div className="text-xs text-muted-foreground pt-1">
                  외 {previewContacts.length - 10}명
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================
// 개별 연락처 칩 패널 — 10개 이하면 펼쳐, 초과면 접었다가 펼치기
// ============================================================
function IndividualContactsPanel({
  ids,
  meta,
  onRemove,
  onClear,
}: {
  ids: string[]
  meta: PreviewContact[]
  onRemove: (id: string) => void
  onClear: () => void
}) {
  const [expanded, setExpanded] = useState(ids.length <= 10)
  const metaMap = useMemo(() => new Map(meta.map((c) => [c.id, c])), [meta])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          개별 연락처 {ids.length}명
        </span>
        <div className="flex items-center gap-2">
          {ids.length > 10 && (
            <button
              type="button"
              className="text-[11px] text-primary hover:underline"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '접기' : `전체 보기 (${ids.length})`}
            </button>
          )}
          <button
            type="button"
            className="text-[11px] text-destructive hover:underline"
            onClick={onClear}
          >
            전체 제거
          </button>
        </div>
      </div>

      {expanded && (
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => {
            const c = metaMap.get(id)
            const label = c ? c.name ?? c.email : id.slice(0, 6)
            return (
              <Badge
                key={id}
                variant="outline"
                className="text-[11px] pl-1.5 pr-0.5 py-0 flex items-center gap-1"
              >
                <span className="truncate max-w-[160px]">{label}</span>
                <button
                  type="button"
                  className="ml-0.5 hover:text-destructive rounded p-0.5"
                  onClick={() => onRemove(id)}
                  aria-label={`${label} 제거`}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ============================================================
// 제외된 수신자 칩 패널 — 그룹 union 안에 있지만 최종 수신자에서 빼는 contact
// ============================================================
// 10개 이하면 펼쳐, 초과면 접었다가 펼치기.
// onRestore: 해당 contact 를 제외 명단에서 뺌 (= 다시 수신자에 포함)
// onClearAll: 제외 명단 전체 비움
function ExcludedContactsPanel({
  meta,
  onRestore,
  onClearAll,
}: {
  meta: PreviewContact[]
  onRestore: (id: string) => void
  onClearAll: () => void
}) {
  const [expanded, setExpanded] = useState(meta.length <= 10)

  return (
    <div className="space-y-1.5 border-t pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          제외된 수신자 {meta.length}명
        </span>
        <div className="flex items-center gap-2">
          {meta.length > 10 && (
            <button
              type="button"
              className="text-[11px] text-primary hover:underline"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '접기' : `전체 보기 (${meta.length})`}
            </button>
          )}
          <button
            type="button"
            className="text-[11px] text-primary hover:underline"
            onClick={onClearAll}
          >
            모두 해제
          </button>
        </div>
      </div>

      {expanded && (
        <div className="flex flex-wrap gap-1">
          {meta.map((c) => {
            const label = c.name ?? c.email
            return (
              <Badge
                key={c.id}
                variant="outline"
                className="text-[11px] pl-1.5 pr-0.5 py-0 flex items-center gap-1 border-destructive/40 text-destructive/90 line-through decoration-destructive/50"
              >
                <span className="truncate max-w-[160px]">{label}</span>
                <button
                  type="button"
                  className="ml-0.5 hover:text-primary no-underline rounded p-0.5"
                  onClick={() => onRestore(c.id)}
                  aria-label={`${label} 제외 해제`}
                  title="제외 해제"
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )
          })}
        </div>
      )}
    </div>
  )
}
