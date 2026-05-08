import { useEffect, useState, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Sparkles, Loader2, Search, Wand2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useSuggestContactGroup } from '@/hooks/useSuggestContactGroup'
import { useCreateGroup, useAddMemberToGroup } from '@/hooks/useGroups'
import { useGroupCategories } from '@/hooks/useGroupCategories'
import { useContactsTitleMap } from '@/hooks/useContacts'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'

interface ContactPreview {
  id: string
  name: string | null
  email: string
  company: string | null
  parent_group: string | null
  job_title: string | null
}

const EXAMPLES = [
  '대기업 마케팅 팀장',
  '카카오·네이버·라인 임원',
  'Amplitude 기존 고객 중 CMO/CPO',
  '신세계 그룹 실무자',
  '스타트업 데이터 분석 담당',
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AISuggestGroupDialog({ open, onOpenChange }: Props) {
  const { currentOrg } = useAuth()
  const qc = useQueryClient()
  const suggest = useSuggestContactGroup()
  const createGroup = useCreateGroup()
  const addMember = useAddMemberToGroup()
  const { data: categories = [] } = useGroupCategories()

  const [description, setDescription] = useState('')
  const [groupName, setGroupName] = useState('')
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined)
  const [matchedIds, setMatchedIds] = useState<string[]>([])
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set())
  const [reasoning, setReasoning] = useState('')
  const [totalScanned, setTotalScanned] = useState(0)
  const [previews, setPreviews] = useState<ContactPreview[]>([])
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)

  // dialog 닫을 때 모든 상태 초기화
  useEffect(() => {
    if (!open) {
      setDescription('')
      setGroupName('')
      setCategoryId(undefined)
      setMatchedIds([])
      setExcludedIds(new Set())
      setReasoning('')
      setTotalScanned(0)
      setPreviews([])
      setFilter('')
    }
  }, [open])

  const titleMap = useContactsTitleMap(matchedIds)

  // matched_ids 가 바뀌면 미리보기용 contact 데이터 fetch (이름/회사/그룹사/이메일)
  useEffect(() => {
    let cancelled = false
    if (matchedIds.length === 0) {
      setPreviews([])
      return
    }
    ;(async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, email, company, parent_group, job_title')
        .in('id', matchedIds)
      if (cancelled) return
      if (error) {
        console.error('[AISuggestGroupDialog] preview fetch failed:', error)
        return
      }
      // matched_ids 순서 유지 (AI 가 매칭 강도 순으로 반환했을 가능성)
      const byId = new Map((data ?? []).map((c) => [c.id, c]))
      const ordered = matchedIds
        .map((id) => byId.get(id))
        .filter(Boolean) as ContactPreview[]
      setPreviews(ordered)
    })()
    return () => {
      cancelled = true
    }
  }, [matchedIds])

  const filteredPreviews = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return previews
    return previews.filter((c) => {
      const haystack = [c.name, c.email, c.company, c.parent_group, c.job_title]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [previews, filter])

  const includedIds = useMemo(
    () => previews.filter((c) => !excludedIds.has(c.id)).map((c) => c.id),
    [previews, excludedIds]
  )

  const handleSuggest = async () => {
    if (!currentOrg) return
    const desc = description.trim()
    if (!desc) {
      toast.error('대상을 자연어로 입력해주세요.')
      return
    }
    try {
      const r = await suggest.mutateAsync({ description: desc, orgId: currentOrg.id })
      setMatchedIds(r.matched_ids)
      setExcludedIds(new Set())
      setReasoning(r.reasoning)
      setTotalScanned(r.total_scanned)
      // AI 가 제안한 그룹명을 비어있을 때만 채움 (사용자가 이미 입력했으면 보존)
      if (!groupName.trim() && r.group_name) {
        setGroupName(r.group_name)
      }
      if (r.matched_ids.length === 0) {
        toast.info('매칭되는 연락처가 없습니다. 설명을 조금 더 구체적으로 적어보세요.')
      } else {
        toast.success(`${r.matched_ids.length}명 매칭됨`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(msg || 'AI 호출 실패')
    }
  }

  const handleCreate = async () => {
    if (!currentOrg) return
    const name = groupName.trim()
    if (!name) {
      toast.error('그룹명을 입력해주세요.')
      return
    }
    if (!categoryId) {
      toast.error('카테고리를 선택해주세요.')
      return
    }
    if (includedIds.length === 0) {
      toast.error('포함할 연락처가 없습니다.')
      return
    }
    setCreating(true)
    try {
      const group = await createGroup.mutateAsync({
        name,
        category_id: categoryId,
        description: description.trim() ? `AI 생성: ${description.trim()}` : null,
      })
      // 멤버 일괄 추가 — 순차 처리 (개별 실패해도 가능한 만큼 추가)
      let added = 0
      for (const id of includedIds) {
        try {
          await addMember.mutateAsync({ contactId: id, groupId: group.id })
          added++
        } catch (e) {
          console.warn('[AISuggestGroupDialog] add member failed:', id, e)
        }
      }
      qc.invalidateQueries({ queryKey: ['groups'] })
      qc.invalidateQueries({ queryKey: ['group-members', group.id] })
      toast.success(`그룹 "${name}" 생성 완료 — ${added}명 추가됨`)
      onOpenChange(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(msg || '그룹 생성 실패')
    } finally {
      setCreating(false)
    }
  }

  const toggleExclude = (id: string, checked: boolean) => {
    setExcludedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const hasResults = matchedIds.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-primary" />
            AI 로 그룹 만들기
          </DialogTitle>
          <DialogDescription>
            자연어로 대상을 설명하면 AI 가 연락처를 분석해 매칭되는 사람들을 골라줍니다.
            결과를 검토하고 그대로 그룹으로 저장하세요.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 -mx-6 px-6">
          {/* 자연어 쿼리 */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-description">대상 설명</Label>
            <Textarea
              id="ai-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="예: 대기업 마케팅 팀장, Amplitude 기존 고객 중 임원, 카카오·네이버 데이터 담당"
              rows={2}
              className="resize-none"
              disabled={suggest.isPending}
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="text-[11px] px-2 py-0.5 rounded-full border bg-muted/40 hover:bg-muted transition-colors"
                  onClick={() => setDescription(ex)}
                  disabled={suggest.isPending}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>

          <Button
            type="button"
            onClick={handleSuggest}
            disabled={suggest.isPending || !description.trim()}
            className="w-full"
          >
            {suggest.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                AI 분석 중... (수~십초 소요)
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                {hasResults ? '다시 분석' : '분석 시작'}
              </>
            )}
          </Button>

          {/* 결과 */}
          {hasResults && (
            <>
              <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    전체 {totalScanned}명 중{' '}
                    <span className="font-semibold text-foreground">
                      {matchedIds.length}명 매칭
                    </span>{' '}
                    · 포함 {includedIds.length}명
                  </span>
                  {excludedIds.size > 0 && (
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setExcludedIds(new Set())}
                    >
                      모두 포함
                    </button>
                  )}
                </div>
                {reasoning && (
                  <p className="text-[11px] text-muted-foreground italic">
                    매칭 기준: {reasoning}
                  </p>
                )}
              </div>

              {/* 그룹 정보 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ai-group-name">그룹명 *</Label>
                  <Input
                    id="ai-group-name"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="AI 가 제안한 이름"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-category">카테고리 *</Label>
                  <Select value={categoryId} onValueChange={setCategoryId}>
                    <SelectTrigger id="ai-category">
                      <SelectValue placeholder="카테고리 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* 미리보기 + 체크박스로 제외 가능 */}
              <div className="space-y-1.5">
                <Label>매칭된 연락처 미리보기</Label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    className="pl-7 h-8 text-xs"
                    placeholder="결과 안에서 검색"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
                <ScrollArea className="h-64 rounded-lg border">
                  <div className="divide-y">
                    {filteredPreviews.length === 0 ? (
                      <div className="p-4 text-center text-xs text-muted-foreground">
                        검색 결과 없음
                      </div>
                    ) : (
                      filteredPreviews.map((c) => {
                        const included = !excludedIds.has(c.id)
                        const liveTitle = titleMap.data?.get(c.id) || c.job_title || ''
                        return (
                          <div
                            key={c.id}
                            className="flex items-center gap-2 px-3 py-2"
                          >
                            <Checkbox
                              checked={included}
                              onCheckedChange={(v) => toggleExclude(c.id, !!v)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-medium truncate">
                                  {c.name ?? c.email}
                                </span>
                                {c.parent_group && (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] py-0 px-1.5 h-4 border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 bg-violet-50/60 dark:bg-violet-900/20"
                                  >
                                    {c.parent_group}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {c.email}
                                {c.company ? ` · ${c.company}` : ''}
                                {liveTitle ? ` · ${liveTitle}` : ''}
                              </p>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </ScrollArea>
                <p className="text-[11px] text-muted-foreground">
                  체크 해제 시 그룹에서 제외됩니다. 검색은 클라이언트 필터 — 결과 자체는 변하지 않아요.
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            취소
          </Button>
          {hasResults && (
            <Button
              type="button"
              onClick={handleCreate}
              disabled={
                creating ||
                !groupName.trim() ||
                !categoryId ||
                includedIds.length === 0
              }
            >
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  생성 중...
                </>
              ) : (
                `그룹 생성 (${includedIds.length}명)`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
