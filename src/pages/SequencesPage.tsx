// 시퀀스(자동 후속 cadence) 관리 — 목록/빌더/등록 (고도화 Tier1-D).

import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, GripVertical, Send, Workflow, Archive, UserPlus, Search, Loader2, Pencil, Check, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import {
  useSequences,
  useSequence,
  useSequenceEnrollments,
  useSequenceStepFunnel,
  useCreateSequence,
  useUpdateSequence,
  useDeleteSequence,
  useSaveSequenceSteps,
  useEnrollContacts,
  useStopEnrollment,
  type StepInput,
} from '@/hooks/useSequences'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'

function enrollmentStatusLabel(status: string, reason: string | null): string {
  switch (status) {
    case 'active': return '진행중'
    case 'completed': return '완료'
    case 'failed': return '실패'
    case 'stopped':
      switch (reason) {
        case 'replied': return '중단 (회신)'
        case 'unsubscribed': return '중단 (수신거부)'
        case 'bounced': return '중단 (반송)'
        case 'manual': return '중단 (수동)'
        default: return '중단'
      }
    default: return status
  }
}

function pctStr(n: number, d: number): string {
  if (d <= 0) return '—'
  return `${Math.round((n / d) * 1000) / 10}%`
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'completed': return 'bg-blue-100 text-blue-700 border-blue-200'
    case 'failed': return 'bg-rose-100 text-rose-700 border-rose-200'
    default: return 'bg-muted text-muted-foreground'
  }
}

export default function SequencesPage() {
  const { data: sequences = [], isLoading } = useSequences()
  const [createOpen, setCreateOpen] = useState(false)
  const [activeSeqId, setActiveSeqId] = useState<string | null>(null)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Workflow className="w-6 h-6 text-primary" /> 시퀀스
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            정해진 스텝(영업일 간격)으로 자동 후속 메일을 보냅니다. 회신·수신거부·반송 시 자동 중단됩니다.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-1" /> 새 시퀀스
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : sequences.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          아직 시퀀스가 없습니다. <span className="font-medium text-foreground">새 시퀀스</span>로 첫 자동 후속 cadence 를 만들어보세요.
        </Card>
      ) : (
        <div className="grid gap-3">
          {sequences.map((s) => (
            <Card
              key={s.id}
              className="p-4 flex items-center justify-between cursor-pointer hover:bg-accent/40 transition-colors"
              onClick={() => setActiveSeqId(s.id)}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold truncate">{s.name}</span>
                  {s.status === 'archived' && (
                    <Badge variant="outline" className="bg-muted text-muted-foreground">보관됨</Badge>
                  )}
                </div>
                {s.description && (
                  <p className="text-sm text-muted-foreground truncate mt-0.5">{s.description}</p>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground shrink-0">
                <span>{s.step_count}스텝</span>
                <span className="text-foreground font-medium">{s.active_count}명 진행중</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreateSequenceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => { setCreateOpen(false); setActiveSeqId(id) }}
      />

      {activeSeqId && (
        <SequenceBuilderSheet
          key={activeSeqId}
          sequenceId={activeSeqId}
          open={!!activeSeqId}
          onOpenChange={(o) => { if (!o) setActiveSeqId(null) }}
        />
      )}
    </div>
  )
}

function CreateSequenceDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const create = useCreateSequence()

  useEffect(() => { if (open) { setName(''); setDescription('') } }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 시퀀스</DialogTitle>
          <DialogDescription>이름을 정하고 스텝은 다음 화면에서 추가합니다.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>이름</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 신규 리드 3단계 후속" />
          </div>
          <div className="space-y-1.5">
            <Label>설명 (선택)</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="용도 메모" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
          <Button
            disabled={!name.trim() || create.isPending}
            onClick={async () => {
              const id = await create.mutateAsync({ name: name.trim(), description: description.trim() || undefined })
              onCreated(id)
            }}
          >
            만들기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SequenceBuilderSheet({
  sequenceId, open, onOpenChange,
}: { sequenceId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, isLoading } = useSequence(sequenceId)
  const { data: enrollments = [] } = useSequenceEnrollments(sequenceId)
  const { data: funnel = [] } = useSequenceStepFunnel(sequenceId)
  const saveSteps = useSaveSequenceSteps()
  const updateSeq = useUpdateSequence()
  const deleteSeq = useDeleteSequence()
  const stopEnr = useStopEnrollment()
  const [steps, setSteps] = useState<StepInput[]>([])
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // 이름·설명 인라인 편집
  const [editingMeta, setEditingMeta] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')

  useEffect(() => {
    if (data?.steps) {
      setSteps(
        data.steps.map((s) => ({
          step_order: s.step_order, wait_days: s.wait_days, subject: s.subject, body_html: s.body_html,
        })),
      )
    }
  }, [data?.steps])

  const seq = data?.sequence
  const archived = seq?.status === 'archived'

  function startEditMeta() {
    setEditName(seq?.name ?? '')
    setEditDesc(seq?.description ?? '')
    setEditingMeta(true)
  }
  function saveMeta() {
    if (!editName.trim()) return
    updateSeq.mutate(
      { id: sequenceId, data: { name: editName.trim(), description: editDesc.trim() || null } },
      { onSuccess: () => setEditingMeta(false) },
    )
  }

  function addStep() {
    setSteps((prev) => [
      ...prev,
      { step_order: prev.length + 1, wait_days: prev.length === 0 ? 0 : 3, subject: '', body_html: '' },
    ])
  }
  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx))
  }
  function patchStep(idx: number, patch: Partial<StepInput>) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }

  const canSave = steps.every((s) => s.subject.trim()) && steps.length > 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          {editingMeta ? (
            <div className="space-y-2">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="시퀀스 이름"
                className="font-semibold"
              />
              <Input
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="설명 (선택)"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={!editName.trim() || updateSeq.isPending} onClick={saveMeta}>
                  <Check className="w-3.5 h-3.5 mr-1" /> 저장
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingMeta(false)}>
                  <X className="w-3.5 h-3.5 mr-1" /> 취소
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 pr-8">
                <SheetTitle className="truncate">{seq?.name ?? '시퀀스'}</SheetTitle>
                {seq && (
                  <Button
                    size="icon" variant="ghost" className="h-7 w-7 shrink-0"
                    onClick={startEditMeta}
                    title="이름·설명 수정"
                  >
                    <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                )}
              </div>
              <SheetDescription>{seq?.description || '스텝과 등록을 관리합니다.'}</SheetDescription>
            </>
          )}
        </SheetHeader>

        {isLoading || !seq ? (
          <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-6 py-4">
            {/* 스텝 에디터 */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm">스텝</h3>
                <Button size="sm" variant="outline" onClick={addStep}><Plus className="w-3.5 h-3.5 mr-1" />스텝 추가</Button>
              </div>
              {steps.length === 0 && (
                <p className="text-sm text-muted-foreground">스텝을 추가하세요. 첫 스텝 대기를 0으로 두면 등록 즉시, 이후는 직전 스텝 발송 후 지정 영업일 뒤 발송됩니다. 캠페인 후속용 시퀀스라면 첫 스텝 대기를 1영업일 이상으로 두는 것을 권장합니다.</p>
              )}
              <div className="space-y-3">
                {steps.map((s, idx) => (
                  <Card key={idx} className="p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <GripVertical className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium">스텝 {idx + 1}</span>
                      <div className="flex items-center gap-1.5 ml-auto text-sm">
                        <span className="text-muted-foreground">대기</span>
                        <Input
                          type="number" min={0}
                          className="w-16 h-8"
                          value={s.wait_days}
                          onChange={(e) => patchStep(idx, { wait_days: Math.max(0, Number(e.target.value) || 0) })}
                        />
                        <span className="text-muted-foreground">영업일</span>
                      </div>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => removeStep(idx)}>
                        <Trash2 className="w-4 h-4 text-muted-foreground" />
                      </Button>
                    </div>
                    <Input
                      placeholder="제목 (예: {{name}}님께 — 후속 안내)"
                      value={s.subject}
                      onChange={(e) => patchStep(idx, { subject: e.target.value })}
                    />
                    <Textarea
                      placeholder="본문 (HTML). 변수: {{name}} {{company}} {{parent_group}} {{job_title}} {{first_name}}"
                      rows={4}
                      value={s.body_html}
                      onChange={(e) => patchStep(idx, { body_html: e.target.value })}
                    />
                  </Card>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Button disabled={!canSave || saveSteps.isPending} onClick={() => saveSteps.mutate({ sequenceId, steps })}>
                  <Send className="w-4 h-4 mr-1" /> 스텝 저장
                </Button>
                <Button
                  variant="outline"
                  onClick={() => updateSeq.mutate({ id: sequenceId, data: { status: archived ? 'active' : 'archived' } })}
                >
                  <Archive className="w-4 h-4 mr-1" /> {archived ? '보관 해제' : '보관'}
                </Button>
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="w-4 h-4 mr-1" /> 삭제
                </Button>
              </div>
            </section>

            {/* 스텝별 전환 퍼널 */}
            {funnel.length > 0 && (
              <section className="space-y-3 border-t pt-4">
                <h3 className="font-semibold text-sm">스텝별 성과</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>스텝</TableHead>
                      <TableHead className="text-right">발송</TableHead>
                      <TableHead className="text-right">오픈율</TableHead>
                      <TableHead className="text-right">회신율</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {funnel.map((f) => (
                      <TableRow key={f.step_order}>
                        <TableCell>스텝 {f.step_order}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{f.sent}</TableCell>
                        <TableCell className="text-right">{pctStr(f.opened, f.sent)}</TableCell>
                        <TableCell className="text-right font-medium">{pctStr(f.replied, f.sent)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-xs text-muted-foreground">
                  회신율이 급감하는 스텝이 있으면 그 스텝의 메시지를 개선해 보세요.
                </p>
              </section>
            )}

            {/* 등록 */}
            <section className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm">등록된 연락처 ({enrollments.length})</h3>
                <Button size="sm" onClick={() => setEnrollOpen(true)} disabled={steps.length === 0}>
                  <UserPlus className="w-3.5 h-3.5 mr-1" /> 연락처 등록
                </Button>
              </div>
              {enrollments.length === 0 ? (
                <p className="text-sm text-muted-foreground">아직 등록된 연락처가 없습니다.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>연락처</TableHead>
                      <TableHead>상태</TableHead>
                      <TableHead className="text-right">스텝</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {enrollments.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="min-w-0">
                          <div className="font-medium truncate">{e.contact?.name || e.contact?.email || '—'}</div>
                          {e.contact?.email && <div className="text-xs text-muted-foreground truncate">{e.contact.email}</div>}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusBadgeClass(e.status)}>
                            {enrollmentStatusLabel(e.status, e.stopped_reason)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {e.current_step_order}/{steps.length}
                        </TableCell>
                        <TableCell className="text-right">
                          {e.status === 'active' && (
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => stopEnr.mutate({ enrollmentId: e.id, sequenceId })}
                            >
                              중단
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </div>
        )}

        <EnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} sequenceId={sequenceId} />

        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="시퀀스 삭제"
          description={`"${seq?.name ?? ''}" 시퀀스를 삭제하시겠습니까? 스텝과 진행 중인 등록(${enrollments.length}건)이 모두 삭제되며 되돌릴 수 없습니다. 이 시퀀스를 후속으로 지정한 캠페인은 후속 없음으로 바뀝니다.`}
          confirmLabel="삭제"
          variant="destructive"
          loading={deleteSeq.isPending}
          onConfirm={() => {
            deleteSeq.mutate(sequenceId, {
              onSuccess: () => { setDeleteOpen(false); onOpenChange(false) },
            })
          }}
        />
      </SheetContent>
    </Sheet>
  )
}

interface PickContact { id: string; name: string | null; email: string; company: string | null }

function EnrollDialog({
  open, onOpenChange, sequenceId,
}: { open: boolean; onOpenChange: (o: boolean) => void; sequenceId: string }) {
  const { currentOrg } = useAuth()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<PickContact[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const enroll = useEnrollContacts()

  useEffect(() => { if (open) { setSearch(''); setResults([]); setSelected({}) } }, [open])

  useEffect(() => {
    if (!open || !currentOrg) return
    let cancelled = false
    setLoading(true)
    const t = setTimeout(async () => {
      let q = supabase
        .from('contacts')
        .select('id, name, email, company')
        .eq('org_id', currentOrg.id)
        .eq('is_unsubscribed', false)
        .eq('is_bounced', false)
        .order('updated_at', { ascending: false })
        .limit(50)
      const term = search.trim()
      if (term) q = q.or(`name.ilike.%${term}%,email.ilike.%${term}%,company.ilike.%${term}%`)
      const { data } = await q
      if (!cancelled) {
        setResults((data ?? []) as PickContact[])
        setLoading(false)
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search, open, currentOrg])

  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>연락처 등록</DialogTitle>
          <DialogDescription>이미 등록됐거나 수신거부/반송된 연락처는 자동 제외됩니다.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="이름·이메일·회사 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="max-h-72 overflow-y-auto border rounded-md divide-y">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">검색 결과 없음</div>
          ) : (
            results.map((c) => (
              <label key={c.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-accent/40">
                <Checkbox
                  checked={!!selected[c.id]}
                  onCheckedChange={(v) => setSelected((prev) => ({ ...prev, [c.id]: !!v }))}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{c.name || c.email}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {c.email}{c.company ? ` · ${c.company}` : ''}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
          <Button
            disabled={selectedIds.length === 0 || enroll.isPending}
            onClick={async () => {
              await enroll.mutateAsync({ sequenceId, contactIds: selectedIds })
              onOpenChange(false)
            }}
          >
            {selectedIds.length}명 등록
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
