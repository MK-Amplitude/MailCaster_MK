// 최종 수신자 검토 — 캠페인 편집 화면의 미리보기 아래에 표시.
//
// 이름 / 이메일 / 회사 / 직책 컬럼으로 발송 직전 최종 검토. 행 단위 ×
// 버튼으로 제외, 상단 "+ 추가" 로 검색 후 개별 추가.
//
// 그룹 기반 수신자도 행 단위로 제외 가능 (excludedContactIds 사용).
// "추가" 는 selectedContactIds 에 직접 추가 — RecipientBasket 의 개별 연락처
// 바구니와 같은 source of truth.

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Plus, Search, X, Users } from 'lucide-react'
import { matchesSearch } from '@/lib/search'
import { useContacts } from '@/hooks/useContacts'

export interface FinalReviewContact {
  id: string
  email: string
  name: string | null
  company: string | null
  job_title: string | null
  department: string | null
}

interface Props {
  // 현재 발송 대상 (그룹 + 개별 - 제외)
  previewContacts: FinalReviewContact[]
  // 그룹에서 들어왔어도 행 단위로 제외 가능 — excludedContactIds 갱신
  excludedContactIds: string[]
  setExcludedContactIds: (ids: string[]) => void
  // "+ 추가" 시 개별 바구니에 직접 합류
  selectedContactIds: string[]
  setSelectedContactIds: (ids: string[]) => void
}

export function FinalRecipientReview({
  previewContacts,
  excludedContactIds,
  setExcludedContactIds,
  selectedContactIds,
  setSelectedContactIds,
}: Props) {
  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch] = useState('')

  const handleRemove = (id: string) => {
    if (excludedContactIds.includes(id)) return
    setExcludedContactIds([...excludedContactIds, id])
  }

  // 추가 popover — 전체 연락처 검색 후 선택.
  const { data: allContacts = [] } = useContacts({
    scope: 'org',
    status: 'normal',
    sort: { field: 'name', dir: 'asc' },
  })

  // 이미 선택돼 있거나 미리보기에 들어있는 사람은 제외하고 후보로 노출.
  const candidateContacts = useMemo(() => {
    const existing = new Set(previewContacts.map((c) => c.id))
    const q = search.trim()
    return allContacts
      .filter((c) => !existing.has(c.id))
      .filter((c) =>
        !q ||
          matchesSearch(c.name, q) ||
          matchesSearch(c.email, q) ||
          matchesSearch(c.company, q) ||
          matchesSearch(c.job_title, q) ||
          matchesSearch(c.department, q),
      )
      .slice(0, 50)
  }, [allContacts, previewContacts, search])

  const handleAdd = (contactId: string) => {
    // 제외 목록에 있었다면 해제 (재포함). 개별 바구니에도 추가.
    if (excludedContactIds.includes(contactId)) {
      setExcludedContactIds(excludedContactIds.filter((id) => id !== contactId))
    }
    if (!selectedContactIds.includes(contactId)) {
      setSelectedContactIds([...selectedContactIds, contactId])
    }
    setSearch('')
  }

  return (
    <div className="space-y-2 mt-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">최종 수신자</h3>
          <Badge variant="secondary" className="text-xs">
            {previewContacts.length}명
          </Badge>
        </div>
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs">
              <Plus className="w-3.5 h-3.5 mr-1" />
              수신자 추가
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-96 p-2" align="end">
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="이름/이메일/회사/부서 검색 (초성 가능)"
                  className="h-8 pl-7 text-sm"
                />
              </div>
              <div className="max-h-72 overflow-y-auto -mx-1 px-1">
                {candidateContacts.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-4 text-center">
                    {search.trim() ? '검색 결과가 없습니다.' : '추가할 수 있는 연락처가 없습니다.'}
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {candidateContacts.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => handleAdd(c.id)}
                          className="w-full text-left px-2 py-1.5 rounded hover:bg-accent flex items-baseline gap-2 group"
                        >
                          <span className="text-sm truncate font-medium">
                            {c.name ?? c.email}
                          </span>
                          <span className="text-xs text-muted-foreground truncate flex-1">
                            {c.email}
                          </span>
                          {c.company && (
                            <span className="text-[11px] text-muted-foreground truncate">
                              {c.company}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="border rounded overflow-hidden">
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 sticky top-0">
              <tr>
                <th className="text-left px-2.5 py-1.5 font-medium">이름</th>
                <th className="text-left px-2.5 py-1.5 font-medium">이메일</th>
                <th className="text-left px-2.5 py-1.5 font-medium">회사</th>
                <th className="text-left px-2.5 py-1.5 font-medium">직책</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {previewContacts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-6 text-muted-foreground">
                    수신자가 없습니다. 위쪽 "수신자 추가" 또는 그룹/연락처 섹션에서 선택하세요.
                  </td>
                </tr>
              ) : (
                previewContacts.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/20">
                    <td className="px-2.5 py-1.5 truncate max-w-[120px]">
                      {c.name ?? <span className="text-muted-foreground">-</span>}
                    </td>
                    <td className="px-2.5 py-1.5 truncate max-w-[200px] text-muted-foreground">
                      {c.email}
                    </td>
                    <td className="px-2.5 py-1.5 truncate max-w-[160px]">
                      {c.company ?? <span className="text-muted-foreground">-</span>}
                    </td>
                    <td className="px-2.5 py-1.5 truncate max-w-[120px]">
                      {c.job_title ?? <span className="text-muted-foreground">-</span>}
                    </td>
                    <td className="px-1 py-1 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => handleRemove(c.id)}
                        title="이 수신자만 제외"
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        × 버튼 — 그룹에서 들어온 수신자도 이 캠페인에서만 제외됩니다.
        제외한 사람은 위쪽 "수신자" 섹션에서 다시 해제 가능합니다.
      </p>
    </div>
  )
}
