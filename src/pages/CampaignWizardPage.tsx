import { useState, useMemo, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
// DropdownMenu 는 ./campaign-wizard/VariableDropdown 으로 이동.
import { SignaturePreview } from '@/components/signatures/SignaturePreview'
import TipTapEditor from '@/components/signatures/TipTapEditor'
import { AttachmentSection, ATTACHMENT_SAFE_THRESHOLD } from '@/components/attachments/AttachmentSection'
import { RecipientBasket } from '@/components/campaigns/RecipientBasket'
import { CcBccPicker } from '@/components/campaigns/CcBccPicker'
import { FinalRecipientReview } from '@/components/campaigns/FinalRecipientReview'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { useGroups } from '@/hooks/useGroups'
import { useTemplates } from '@/hooks/useTemplates'
import { useSignatures } from '@/hooks/useSignatures'
import { useCreateCampaign, updateCampaignCas, CampaignStatusConflictError } from '@/hooks/useCampaigns'
import { useSequenceOptions } from '@/hooks/useSequences'
import { useValidateEmails, type ValidationResult } from '@/hooks/useValidateEmails'
import { renderTemplate, renderTemplateHtml, extractVariables } from '@/lib/mailMerge'
import { toast } from 'sonner'
import { AMBIGUOUS_SEND_MESSAGE } from '@/lib/gmail'
import type { Database } from '@/types/database.types'

type DriveAttachmentRow = Database['mailcaster']['Tables']['drive_attachments']['Row']
import {
  ArrowLeft,
  Check,
  Users,
  Send,
  Loader2,
  CalendarClock,
  Plus,
  ArrowUp,
  ArrowDown,
  X,
  Blocks,
  RotateCcw,
  Paperclip,
  Pencil,
  Undo2,
} from 'lucide-react'
import { useSidebar } from '@/contexts/SidebarContext'
import { fetchAllPages, chunk, IN_FILTER_CHUNK } from '@/lib/fetchAll'
import { dedupeEmails, isMissingTableError } from './campaign-wizard/helpers'
import { VariableDropdown } from './campaign-wizard/VariableDropdown'
import { ScheduleSection } from './campaign-wizard/ScheduleSection'

interface PreviewContact {
  id: string
  email: string
  name: string | null
  company: string | null
  department: string | null
  /** 사용 직책 (display_title) > 원본 직책 (job_title) — 메일 템플릿 {{job_title}} 으로 들어감 */
  job_title: string | null
  /** 원본 직책 — 메일 템플릿 {{job_title_raw}} 로 접근 가능 (선택) */
  job_title_raw?: string | null
}

interface TemplateOpt {
  id: string
  name: string
  subject: string
  body_html: string
}

interface BlockItem {
  key: string          // UI 키 (아직 DB 저장 전)
  templateId: string
}

type ReuseMode = 'all' | 'failed'

// ------------------------------------------------------------
// CC / BCC 유틸 — 그룹 / 개별 연락처 id 를 이메일로 펼치고, dedupe 한다.
// ------------------------------------------------------------
// 수신거부 / 반송 연락처는 제외한다 (To 측 rawUnion 과 동일한 정책).
// 그룹 경유는 보관(archived) 연락처도 제외 — 연락처 목록 화면과 같은 기준.
// 동일 이메일이 여러 그룹이나 contact 에서 유입돼도 한 번만 반환.
// 이메일 대소문자는 DB 원본을 보존(Map 의 value) 하고, 비교만 lowercase 로 수행.
async function resolveBasketEmails(
  groupIds: string[],
  contactIds: string[],
): Promise<string[]> {
  type EmailRow = { email: string | null; is_unsubscribed: boolean; is_bounced: boolean }
  const emails = new Map<string, string>()
  const add = (c: EmailRow | null) => {
    if (!c || c.is_unsubscribed || c.is_bounced || !c.email) return
    const em = c.email.trim()
    if (!em) return
    emails.set(em.toLowerCase(), em)
  }
  if (groupIds.length > 0) {
    const rows = await fetchAllPages<{ contacts: EmailRow | null }>((from, to) =>
      supabase
        .from('contact_groups')
        .select('id, contacts!inner(email, is_unsubscribed, is_bounced)')
        .in('group_id', groupIds)
        .is('contacts.archived_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    ).catch((error) => {
      console.error('[wizard] resolve cc/bcc groups failed:', error)
      throw error
    })
    for (const row of rows) add(row.contacts)
  }
  for (const ids of chunk(contactIds, IN_FILTER_CHUNK)) {
    const { data, error } = await supabase
      .from('contacts')
      .select('email, is_unsubscribed, is_bounced')
      .in('id', ids)
    if (error) {
      console.error('[wizard] resolve cc/bcc contacts failed:', error)
      throw error
    }
    for (const c of (data ?? []) as EmailRow[]) add(c)
  }
  return [...emails.values()]
}

// 발송 간격 상한 — 서버 발송은 1회 실행(~50초) 안에서 간격을 두므로 30초를 넘기면
// 실행당 1통 수준으로 느려진다 (send-scheduled-campaigns 도 같은 값으로 상한 적용).
const MAX_SEND_DELAY_SECONDS = 30
function clampDelaySeconds(v: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : 0
  return Math.min(MAX_SEND_DELAY_SECONDS, Math.max(0, n))
}

// 수신자 스냅샷(recipients.variables) 과 같은 키 — 빈 값 사전 점검용.
function previewContactVars(c: PreviewContact): Record<string, string> {
  return {
    name: c.name ?? '',
    email: c.email ?? '',
    company: c.company ?? '',
    department: c.department ?? '',
    job_title: c.job_title ?? '',
    job_title_raw: c.job_title_raw ?? c.job_title ?? '',
  }
}

// dedupeEmails / isMissingTableError 는 ./campaign-wizard/helpers.ts 로 이동.

// ------------------------------------------------------------
// CC / BCC 바구니 메타 교체 헬퍼 (편집 모드 + 신규 저장 모두 사용)
// ------------------------------------------------------------
// Supabase JS 는 트랜잭션이 없으므로 delete→insert 로 교체한다.
// 빈 배열이 들어오면 단순히 delete 만 수행 — child row 를 깔끔히 비운다.
//
// 방어 전략:
//   - 테이블이 없는 경우(42P01, migration 012 미적용) 는 조용히 skip + 경고 반환.
//     campaigns.cc / campaigns.bcc 는 이미 최종 이메일로 저장됐으므로 발송은 정상 동작.
//     사용자는 편집 모드에서 그룹/개별 선택이 복원되지 않을 뿐.
//   - 그 외 에러(RLS 차단, FK 위반 등) 는 상위 catch 로 throw 해 원인을 표시.
//
// 반환값: { missingTable: boolean } — 호출자가 1회 경고 토스트로 안내할 때 사용.
async function replaceCcBccRows(
  campaignId: string,
  kind: 'cc' | 'bcc',
  groupIds: string[],
  contactIds: string[],
): Promise<{ missingTable: boolean }> {
  const groupsTable = kind === 'cc' ? 'campaign_cc_groups' : 'campaign_bcc_groups'
  const contactsTable =
    kind === 'cc' ? 'campaign_cc_contacts' : 'campaign_bcc_contacts'

  // 모듈 스코프 헬퍼 재사용
  const isMissingTable = isMissingTableError

  // 1) 기존 메타 삭제 (groups)
  {
    const { error } = await supabase
      .from(groupsTable)
      .delete()
      .eq('campaign_id', campaignId)
    if (error) {
      if (isMissingTable(error)) {
        console.warn(`[wizard] ${groupsTable} missing — migration 012 not applied?`, error)
        return { missingTable: true }
      }
      throw error
    }
  }
  // 2) 기존 메타 삭제 (contacts)
  {
    const { error } = await supabase
      .from(contactsTable)
      .delete()
      .eq('campaign_id', campaignId)
    if (error) {
      if (isMissingTable(error)) {
        console.warn(`[wizard] ${contactsTable} missing — migration 012 not applied?`, error)
        return { missingTable: true }
      }
      throw error
    }
  }

  // 3) 새 메타 삽입 (빈 배열이면 skip)
  if (groupIds.length > 0) {
    const rows = groupIds.map((group_id) => ({ campaign_id: campaignId, group_id }))
    const { error } = await supabase.from(groupsTable).insert(rows)
    if (error) {
      if (isMissingTable(error)) {
        console.warn(`[wizard] ${groupsTable} missing on insert`, error)
        return { missingTable: true }
      }
      throw error
    }
  }
  if (contactIds.length > 0) {
    const rows = contactIds.map((contact_id) => ({ campaign_id: campaignId, contact_id }))
    const { error } = await supabase.from(contactsTable).insert(rows)
    if (error) {
      if (isMissingTable(error)) {
        console.warn(`[wizard] ${contactsTable} missing on insert`, error)
        return { missingTable: true }
      }
      throw error
    }
  }

  return { missingTable: false }
}

export default function CampaignWizardPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const qc = useQueryClient()

  // Auto-hide sidebar for maximum workspace
  const { setOpen: setSidebarOpen } = useSidebar()
  useEffect(() => {
    setSidebarOpen(false)
    return () => setSidebarOpen(true)
  }, [setSidebarOpen])

  const [searchParams, setSearchParams] = useSearchParams()
  const reuseFrom = searchParams.get('from')
  const reuseMode = searchParams.get('mode') as ReuseMode | null
  const editCampaignId = searchParams.get('edit')
  const isEditMode = !!editCampaignId

  // 다른 페이지(관계 관리 등) 에서 navigate(state) 로 넘긴 pre-selected contact ids
  // — 새 캠페인 모드 + reuse/edit 아닌 경우에만 적용.
  const location = useLocation()
  const preselectedContactIds: string[] = useMemo(() => {
    const raw = (location.state as { preselectedContactIds?: unknown })?.preselectedContactIds
    if (!Array.isArray(raw)) return []
    return raw.filter((v): v is string => typeof v === 'string')
  }, [location.state])

  const [submitting, setSubmitting] = useState(false)

  const [name, setName] = useState('')
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  // Phase 5: 개별 연락처 바구니 — 그룹과 병존, 최종 수신자는 양쪽을 union+dedupe.
  // 관계 관리 등 다른 페이지에서 preselectedContactIds 로 시작하면 초기값으로 채움.
  // (edit/reuse 모드는 별도 effect 가 덮어쓰므로 초기값만 영향)
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>(
    !isEditMode && !reuseFrom ? preselectedContactIds : []
  )
  // Phase 6 (B): 캠페인 단위 제외 명단 — campaign_exclusions 에 저장.
  // 그룹 union 안의 contact 를 최종 수신자에서 빼고 싶을 때 사용.
  const [excludedContactIds, setExcludedContactIds] = useState<string[]>([])

  const [blocks, setBlocks] = useState<BlockItem[]>([])
  const [signatureId, setSignatureId] = useState<string>('')
  const [subject, setSubject] = useState('')

  // 사용자가 우측 미리보기에서 합쳐진 본문을 직접 편집하면 그 HTML 을 보관.
  // null 이면 composedHtml(블록+서명) 을 그대로 사용.
  // 블록을 바꾸면 바로 반영돼야 할지(= null 유지) 그대로 둘지(= override 유지) 는 UX 결정.
  // 여기선 "override 우선" — 사용자가 직접 편집한 건 본인이 명시적으로 '블록으로 되돌리기' 하기 전엔 안 사라진다.
  const [bodyOverride, setBodyOverride] = useState<string | null>(null)
  // bodyOverride 가 어디서 왔는지: 'auto' = 편집 모드 로드 시 db 에서 자동 시드,
  //                                'manual' = 사용자가 미리보기에서 직접 편집.
  // 서명만 바꿨을 때 자동 시드 본문을 폐기하고 새 composedHtml 로 다시 그려주기 위해 분리.
  const bodyOverrideOriginRef = useRef<'auto' | 'manual' | null>(null)

  const [delaySeconds, setDelaySeconds] = useState(3)

  // 캠페인 레벨 CC / BCC (발송 모드와 무관하게 모든 메일에 동일하게 붙음)
  //
  // 각각 3 가지 입력 소스를 분리해서 저장:
  //   - {kind}Emails     : 사용자가 직접 타이핑한 이메일 (EmailChipInput)
  //   - {kind}GroupIds   : 선택된 그룹 — 발송 시 그룹 멤버의 이메일이 자동 포함
  //   - {kind}ContactIds : 선택된 개별 연락처 — 발송 시 해당 연락처의 이메일이 포함
  //
  // 최종 DB 저장 시 campaigns.cc / campaigns.bcc 는 3 소스를 union+dedupe 한 TEXT[] 로
  // 넣는다 (resolvedCcEmails / resolvedBccEmails 참조). useSendCampaign 은 campaigns.cc
  // 필드만 읽으므로 발송 경로는 기존과 동일.
  const [ccEmails, setCcEmails] = useState<string[]>([])
  const [ccGroupIds, setCcGroupIds] = useState<string[]>([])
  const [ccContactIds, setCcContactIds] = useState<string[]>([])
  const [bccEmails, setBccEmails] = useState<string[]>([])
  const [bccGroupIds, setBccGroupIds] = useState<string[]>([])
  const [bccContactIds, setBccContactIds] = useState<string[]>([])
  // 그룹/개별 선택을 이메일로 펼쳐둔 "바구니 이메일" 캐시 (DB 쿼리 결과)
  const [ccBasketEmails, setCcBasketEmails] = useState<string[]>([])
  const [bccBasketEmails, setBccBasketEmails] = useState<string[]>([])
  const [loadingCcBasket, setLoadingCcBasket] = useState(false)
  const [loadingBccBasket, setLoadingBccBasket] = useState(false)
  // 펼치기 실패 시 저장을 막는다 — 실패를 무시하고 저장하면 그 그룹 주소가 빠진 채 발송됨
  const [ccBasketError, setCcBasketError] = useState(false)
  const [bccBasketError, setBccBasketError] = useState(false)

  // 발송 모드: 'individual' = 수신자별 개별 발송 (기본), 'bulk' = 1회 브로드캐스트 (BCC 전원)
  const [sendMode, setSendMode] = useState<'individual' | 'bulk'>('individual')

  // 예약 발송:
  //   scheduledAt = null  → 즉시 발송 (기본, status='draft' 로 저장 후 사용자가 수동으로 '발송하기' 클릭)
  //   scheduledAt = ISO   → 예약 발송 (status='scheduled' 로 저장, pg_cron 이 해당 시각에 자동 발송)
  //
  // 주의: HTML <input type="datetime-local"> 는 "YYYY-MM-DDTHH:mm" 로컬 시간 문자열을 쓴다.
  //       여기선 내부적으로 ISO UTC 로 정규화해 저장 시 DB 로 보낸다.
  const [scheduledAt, setScheduledAt] = useState<string | null>(null)

  // 후속 시퀀스 — 발송 완료 후 수신자를 이 시퀀스에 자동 등록 (캠페인=첫 터치).
  // null = 후속 없음. (069)
  const [followupSequenceId, setFollowupSequenceId] = useState<string | null>(null)

  // 오픈/클릭 트래킹 — 기본 ON. 픽셀 오픈 + 링크 클릭 추적을 동시에 제어 (072).
  const [enableTracking, setEnableTracking] = useState(true)

  // 수신거부 링크 (079) — 기본 ON. 메일 하단 수신거부 footer + List-Unsubscribe 헤더.
  const [includeUnsubscribeLink, setIncludeUnsubscribeLink] = useState(true)

  // 첨부 파일 — 블록 추가 시 해당 템플릿의 첨부가 자동 포함 + 수동 추가 가능
  const [attachments, setAttachments] = useState<DriveAttachmentRow[]>([])

  // 재사용 모드: 원본의 실패 수신자를 그대로 쓰는 경우.
  // null 이면 그룹 기반 preview 사용 (신규/전체복제 동일 플로우).
  const [fixedRecipients, setFixedRecipients] = useState<PreviewContact[] | null>(null)
  const [reuseLoading, setReuseLoading] = useState(!!reuseFrom || !!editCampaignId)
  const [reuseSourceName, setReuseSourceName] = useState<string>('')
  // 편집 모드: 이미 발송 처리(sent/failed/bounced 등)된 수신자 수 — 저장 시 이 행들은 보존되고
  // 다시 발송되지 않는다. 개인화 override 가 있는 수신자 수 — 이들은 아래 제목/본문 대신 override 로 발송.
  const [lockedRecipientCount, setLockedRecipientCount] = useState(0)
  const [overrideRecipientCount, setOverrideRecipientCount] = useState(0)

  const { data: groups = [] } = useGroups()
  const { data: templates = [] } = useTemplates()
  const { data: signatures = [] } = useSignatures()
  const createCampaign = useCreateCampaign()

  // 새 캠페인 — 사용자의 기본 서명(signatures.is_default) 을 자동 선택.
  // 편집/재사용 모드는 db 에서 로드된 signature_id 가 우선 (별도 useEffect 에서 setSignatureId).
  useEffect(() => {
    if (isEditMode || reuseFrom) return
    if (signatureId) return
    if (signatures.length === 0) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = signatures.find((s: any) => s.is_default)
    if (def) setSignatureId(def.id as string)
  }, [signatures, isEditMode, reuseFrom, signatureId])

  const templateById = useMemo(() => {
    const m = new Map<string, TemplateOpt>()
    for (const t of templates) m.set(t.id, t)
    return m
  }, [templates])

  // 블록을 순서대로 이어붙인 HTML (+ 서명)
  const composedHtml = useMemo(() => {
    const parts = blocks
      .map((b) => templateById.get(b.templateId)?.body_html ?? '')
      .filter(Boolean)
    const joined = parts.join('<br/><br/>')
    const signature = signatures.find((s) => s.id === signatureId)
    if (signature) return `${joined}<br/><br/>${signature.html}`
    return joined
  }, [blocks, templateById, signatureId, signatures])

  // 선택된 그룹의 수신자 프리뷰 (중복 이메일 dedupe)
  // Phase 6 (B):
  //   rawUnion       = 그룹 ∪ 개별, 수신거부/반송 제외한 순수 후보
  //   previewContacts = rawUnion − 제외 명단 (최종 발송 대상)
  //   excludedMeta    = rawUnion 중 제외 명단에 속한 것 (UI 칩 표시용)
  // fetchedContacts = 그룹 ∪ 개별 조회 결과 (수신거부/반송 제외, 이메일 중복 포함 — dedupe 는 rawUnion 에서)
  const [fetchedContacts, setFetchedContacts] = useState<PreviewContact[]>([])
  const [loadingPreview, setLoadingPreview] = useState(false)
  // 조회 실패 시 저장 금지 — 이전 결과로 저장하면 campaign_groups 와 recipients 가 어긋난다
  const [previewError, setPreviewError] = useState(false)
  const rawUnion = useMemo(() => {
    if (fixedRecipients !== null) return fixedRecipients
    // 같은 이메일의 연락처가 여러 개(조직 내 다른 소유자)면 하나만 남긴다. 제외 명단에 든 사본이
    // 있으면 그 사본을 대표로 삼아, 조회 순서에 따라 제외가 풀리는 일이 없게 한다.
    const excluded = new Set(excludedContactIds)
    const byEmail = new Map<string, PreviewContact>()
    for (const c of fetchedContacts) {
      const em = (c.email ?? '').trim().toLowerCase()
      if (!em) continue
      const prev = byEmail.get(em)
      if (!prev) byEmail.set(em, c)
      else if (!excluded.has(prev.id) && excluded.has(c.id)) byEmail.set(em, c)
    }
    return Array.from(byEmail.values())
  }, [fixedRecipients, fetchedContacts, excludedContactIds])
  // 저장 시 제외 명단 정리 기준 — 현재 선택에서 조회된 모든 연락처 id (이메일 중복 사본 포함)
  const fetchedContactIds = useMemo(
    () => new Set(fetchedContacts.map((c) => c.id)),
    [fetchedContacts],
  )
  const previewContacts = useMemo(() => {
    if (excludedContactIds.length === 0) return rawUnion
    const excluded = new Set(excludedContactIds)
    return rawUnion.filter((c) => !excluded.has(c.id))
  }, [rawUnion, excludedContactIds])
  const excludedMeta = useMemo(() => {
    if (excludedContactIds.length === 0) return []
    const excluded = new Set(excludedContactIds)
    return rawUnion.filter((c) => excluded.has(c.id))
  }, [rawUnion, excludedContactIds])

  // 자식 컴포넌트에 넘길 파생 배열은 useMemo 로 identity 고정 —
  // 인라인 .map() 은 매 렌더마다 새 배열이라 CcBccPicker / FinalRecipientReview 의
  // 내부 useMemo(수신자 Set 구성 + 1만 행 필터)가 keystroke 마다 재계산되던 문제 방지.
  const recipientEmails = useMemo(
    () => previewContacts.map((c) => c.email),
    [previewContacts],
  )
  const finalReviewContacts = useMemo(
    () =>
      previewContacts.map((c) => ({
        id: c.id,
        email: c.email,
        name: c.name,
        company: c.company,
        job_title: c.job_title,
        department: c.department,
      })),
    [previewContacts],
  )

  // Phase 6 (B): URL 상태 동기화 — mount 시 URL → state seed 1회
  //
  // 쿼리파라미터 포맷: ?groups=<uuid,uuid>&contacts=<uuid>&excluded=<uuid>
  // edit / from 모드에서는 DB 가 권위이므로 seed 건너뜀 (아래 load effect 가 덮어쓰므로 사실상 무해지만
  // 초기값 플래시를 피하기 위해 명시적으로 차단).
  const initialUrlSeededRef = useRef(false)
  useEffect(() => {
    if (initialUrlSeededRef.current) return
    initialUrlSeededRef.current = true
    if (editCampaignId || reuseFrom) return
    const g = searchParams.get('groups')
    const c = searchParams.get('contacts')
    const e = searchParams.get('excluded')
    if (g) setSelectedGroupIds(g.split(',').filter(Boolean))
    if (c) setSelectedContactIds(c.split(',').filter(Boolean))
    if (e) setExcludedContactIds(e.split(',').filter(Boolean))
    // mount-only — eslint deps 는 의도적으로 비워둠
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Phase 6 (B): state → URL 동기화 (replace 로 히스토리 오염 방지)
  // edit / reuse 쿼리파라미터는 그대로 유지 (URLSearchParams 복제로 보존).
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    const setOrDelete = (key: string, v: string[]) => {
      if (v.length === 0) next.delete(key)
      else next.set(key, v.join(','))
    }
    setOrDelete('groups', selectedGroupIds)
    setOrDelete('contacts', selectedContactIds)
    setOrDelete('excluded', excludedContactIds)
    // 같은 내용이면 write 생략 — setSearchParams 가 re-render 를 일으키지 않도록
    const curr = searchParams.toString()
    const nextStr = next.toString()
    if (curr !== nextStr) setSearchParams(next, { replace: true })
    // searchParams 는 deps 에서 의도적으로 제외 — setSearchParams 가 매 틱 새 객체를 만들어 무한루프 방지
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupIds, selectedContactIds, excludedContactIds])

  // 재사용/편집 모드: 원본 캠페인 데이터 로드
  // - reuseFrom: /campaigns/new?from=<id>&mode=all|failed  → 새 캠페인 생성의 초깃값으로 사용
  // - editCampaignId: /campaigns/new?edit=<id>             → 기존 draft/scheduled 캠페인 편집
  useEffect(() => {
    const loadFrom = editCampaignId ?? reuseFrom
    if (!loadFrom) return
    let cancelled = false
    ;(async () => {
      // 1) 핵심 campaigns row 로드
      //    - 이 쿼리가 실패하면 편집 UI 자체가 의미 없다(이름/제목/본문 등을 하나도 못 채움).
      //      → 목록으로 돌려보내 사용자가 혼란스럽지 않게 한다.
      //    - 보조 쿼리(campaign_blocks / campaign_groups / campaign_contacts /
      //      campaign_exclusions / campaign_attachments / recipients / CC·BCC pickers)
      //      는 아래 별도 try 로 분리해, 하나가 실패해도 편집 화면을 유지한다.
      //      (migration 012 미적용·RLS 불일치·일시적 네트워크 오류 등으로 편집이 막히면
      //       사용자 좌절도 크고 복구도 어려움 — 최소 "보이는 필드 수정 → 저장" 경로는 열려있어야 함)
      let c: Record<string, unknown> | null = null
      try {
        const { data, error: cErr } = await supabase
          .from('campaigns')
          .select('name, subject, signature_id, send_delay_seconds, cc, bcc, send_mode, body_html, scheduled_at, status, followup_sequence_id, enable_open_tracking, include_unsubscribe_link')
          .eq('id', loadFrom)
          .single()
        if (cancelled) return
        if (cErr) throw cErr
        c = data as Record<string, unknown> | null
        // 발송 중 / 완료 캠페인은 편집 불가 — 저장이 진행 중인 발송과 경합하거나 발송 이력을 덮어씀.
        const st = c?.status as string | undefined
        if (isEditMode && st !== 'draft' && st !== 'scheduled') {
          toast.error(
            st === 'sending'
              ? '발송 중인 캠페인은 편집할 수 없습니다.'
              : '이미 발송이 시작되었거나 완료된 캠페인은 편집할 수 없습니다. 재사용(복제)을 이용해주세요.',
          )
          setReuseLoading(false)
          navigate(`/campaigns/${loadFrom}`)
          return
        }
      } catch (e) {
        if (cancelled) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyErr = e as any
        console.error('[wizard] core campaign load failed:', {
          message: anyErr?.message,
          code: anyErr?.code,
          details: anyErr?.details,
          hint: anyErr?.hint,
          raw: e,
        })
        toast.error(
          anyErr?.hint || anyErr?.details || anyErr?.message || '원본 메일 발송 로드 실패',
        )
        setReuseLoading(false)
        navigate('/campaigns')
        return
      }

      // 2) 보조 데이터 로드 — 실패해도 편집 화면 유지
      try {
        if (c) {
          setReuseSourceName((c.name as string) ?? '')
          // 편집: 원본 이름 그대로. 재사용: 모드별 suffix 추가.
          const suffix = isEditMode
            ? ''
            : reuseMode === 'failed'
              ? ' - 실패 재발송'
              : ' (복사)'
          setName(`${c.name as string}${suffix}`)
          setSubject((c.subject as string) ?? '')
          setSignatureId((c.signature_id as string | null) ?? '')
          setDelaySeconds(clampDelaySeconds((c.send_delay_seconds as number | null) ?? 3))
          setSendMode((c.send_mode as 'individual' | 'bulk' | null) === 'bulk' ? 'bulk' : 'individual')
          setFollowupSequenceId((c.followup_sequence_id as string | null) ?? null)
          // 기존값 없으면(복제/legacy) 기본 ON
          setEnableTracking((c.enable_open_tracking as boolean | null) ?? true)
          // 기존값 없으면(legacy) DB 기본값과 같이 ON
          setIncludeUnsubscribeLink((c.include_unsubscribe_link as boolean | null) ?? true)

          // Phase 7: CC/BCC 구조화 — 직접 입력 / 그룹 / 개별 연락처 각각 복원.
          // campaigns.cc 는 발송 시 사용되는 최종 이메일 배열(스냅샷) 이고,
          // campaign_cc_groups / campaign_cc_contacts 는 UI state 복원용 메타.
          // 직접 입력 이메일 = campaigns.cc − (그룹/개별에서 펼쳐진 이메일).
          const storedCc = Array.isArray(c.cc) ? (c.cc as string[]) : []
          const storedBcc = Array.isArray(c.bcc) ? (c.bcc as string[]) : []
          const [ccGRes, ccCRes, bccGRes, bccCRes] = await Promise.all([
            supabase.from('campaign_cc_groups').select('group_id').eq('campaign_id', loadFrom),
            supabase.from('campaign_cc_contacts').select('contact_id').eq('campaign_id', loadFrom),
            supabase.from('campaign_bcc_groups').select('group_id').eq('campaign_id', loadFrom),
            supabase.from('campaign_bcc_contacts').select('contact_id').eq('campaign_id', loadFrom),
          ])
          if (cancelled) return
          // 각 쿼리의 error 는 "테이블이 아직 없음" 같은 경우를 허용해야 하므로 조용히 무시
          // (migration 012 이전에 만들어진 캠페인은 child row 가 아예 없어도 OK).
          if (ccGRes.error) console.warn('[wizard] campaign_cc_groups load warn:', ccGRes.error)
          if (ccCRes.error) console.warn('[wizard] campaign_cc_contacts load warn:', ccCRes.error)
          if (bccGRes.error) console.warn('[wizard] campaign_bcc_groups load warn:', bccGRes.error)
          if (bccCRes.error) console.warn('[wizard] campaign_bcc_contacts load warn:', bccCRes.error)

          const loadedCcGroupIds = ((ccGRes.data ?? []) as Array<{ group_id: string }>).map((r) => r.group_id)
          const loadedCcContactIds = ((ccCRes.data ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id)
          const loadedBccGroupIds = ((bccGRes.data ?? []) as Array<{ group_id: string }>).map((r) => r.group_id)
          const loadedBccContactIds = ((bccCRes.data ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id)

          // child 테이블 기반으로 그룹/개별 이메일 펼치기 → 직접 입력과 분리
          const [ccBasket, bccBasket] = await Promise.all([
            resolveBasketEmails(loadedCcGroupIds, loadedCcContactIds).catch((e) => {
              console.warn('[wizard] cc basket resolve warn:', e)
              return [] as string[]
            }),
            resolveBasketEmails(loadedBccGroupIds, loadedBccContactIds).catch((e) => {
              console.warn('[wizard] bcc basket resolve warn:', e)
              return [] as string[]
            }),
          ])
          if (cancelled) return
          const ccBasketSet = new Set(ccBasket.map((e) => e.toLowerCase()))
          const bccBasketSet = new Set(bccBasket.map((e) => e.toLowerCase()))
          setCcEmails(storedCc.filter((e) => !ccBasketSet.has(e.trim().toLowerCase())))
          setCcGroupIds(loadedCcGroupIds)
          setCcContactIds(loadedCcContactIds)
          setCcBasketEmails(ccBasket)
          setBccEmails(storedBcc.filter((e) => !bccBasketSet.has(e.trim().toLowerCase())))
          setBccGroupIds(loadedBccGroupIds)
          setBccContactIds(loadedBccContactIds)
          setBccBasketEmails(bccBasket)
          // 저장된 body_html 을 override 로 보관 — 블록 조합으로 재계산된 composedHtml 과
          // 일치하는지 여부와 무관하게, 사용자가 마지막으로 본 내용 그대로 복원.
          // 블록/서명 로딩이 비동기라 초기 composedHtml 과 비교하기 어려움 + "내가 저장한 그대로"
          // 보이는 게 가장 직관적. '블록으로 되돌리기' 버튼으로 언제든 초기화 가능.
          const storedBody = (c.body_html as string | null) ?? null
          if (storedBody && storedBody.trim()) {
            setBodyOverride(storedBody)
            bodyOverrideOriginRef.current = 'auto'
          }
          // 예약 발송 시각 로드 — 편집 모드 & status='scheduled' 일 때만 의미.
          // (reuseMode 로 재사용할 땐 원본의 예약 시각을 그대로 계승하지 않음 — 새 캠페인이므로)
          if (isEditMode && (c.status as string) === 'scheduled' && c.scheduled_at) {
            setScheduledAt(c.scheduled_at as string)
          }
        }

        const { data: bs, error: bErr } = await supabase
          .from('campaign_blocks')
          .select('template_id, position')
          .eq('campaign_id', loadFrom)
          .order('position', { ascending: true })
        if (cancelled) return
        if (bErr) {
          if (isMissingTableError(bErr)) {
            console.warn('[wizard] campaign_blocks missing — migration 003 not applied?', bErr)
          } else {
            throw bErr
          }
        }
        if (bs && bs.length > 0) {
          // ref 를 setBlocks 전에 먼저 세팅 — 템플릿 첨부 effect 가 "신규" 로 오인식하고
          // 재fetch 하는 걸 방지 (원본 캠페인의 첨부는 아래 campaign_attachments 로 별도 로드됨)
          prevTemplateIdsRef.current = new Set(bs.map((b) => b.template_id as string))
          setBlocks(
            bs.map((b) => ({
              key: crypto.randomUUID(),
              templateId: b.template_id as string,
            }))
          )
        }

        const { data: gs, error: gErr } = await supabase
          .from('campaign_groups')
          .select('group_id')
          .eq('campaign_id', loadFrom)
        if (cancelled) return
        if (gErr) {
          if (isMissingTableError(gErr)) {
            console.warn('[wizard] campaign_groups missing — migration 001 not applied?', gErr)
          } else {
            throw gErr
          }
        }
        if (gs && gs.length > 0) {
          setSelectedGroupIds(gs.map((g) => g.group_id as string))
        }

        // Phase 5: 개별 연락처 바구니 복원 (campaign_contacts 테이블)
        // 편집 모드에서도, 재사용(복제) 모드에서도 원본의 개별 선택을 계승한다.
        // (reuseMode='failed' 는 아래 recipients 기반 fixedRecipients 로 대체되므로 이 로드가 덮여도 무해)
        // PostgREST max_rows(1000) — 잘리면 저장 시 바구니가 축소 재기록되므로 페이지 단위로 전부 읽음
        const { data: ccs, error: ccsErr } = await fetchAllPages<{ contact_id: string }>((from, to) =>
          supabase
            .from('campaign_contacts')
            .select('id, contact_id')
            .eq('campaign_id', loadFrom)
            .order('id', { ascending: true })
            .range(from, to),
        ).then(
          (data) => ({ data, error: null }),
          (error) => ({ data: null, error }),
        )
        if (cancelled) return
        if (ccsErr) {
          if (isMissingTableError(ccsErr)) {
            console.warn('[wizard] campaign_contacts missing — migration 009 not applied?', ccsErr)
          } else {
            throw ccsErr
          }
        }
        if (ccs && ccs.length > 0) {
          setSelectedContactIds(ccs.map((r) => r.contact_id as string))
        }

        // Phase 6 (B): 제외 명단 복원 (campaign_exclusions 테이블)
        // 재사용/편집 모두에서 계승. fixedRecipients 모드에서는 사용하지 않지만
        // state 가 남아있어도 UI 가 렌더하지 않으므로 무해.
        const { data: exs, error: exsErr } = await fetchAllPages<{ contact_id: string }>((from, to) =>
          supabase
            .from('campaign_exclusions')
            .select('id, contact_id')
            .eq('campaign_id', loadFrom)
            .order('id', { ascending: true })
            .range(from, to),
        ).then(
          (data) => ({ data, error: null }),
          (error) => ({ data: null, error }),
        )
        if (cancelled) return
        if (exsErr) {
          if (isMissingTableError(exsErr)) {
            console.warn('[wizard] campaign_exclusions missing — migration 010 not applied?', exsErr)
          } else {
            throw exsErr
          }
        }
        if (exs && exs.length > 0) {
          setExcludedContactIds(exs.map((r) => r.contact_id as string))
        }

        // 원본 캠페인의 첨부 파일 로드 — 재사용/복제/편집 모드 공통
        const { data: cas, error: caErr } = await supabase
          .from('campaign_attachments')
          .select('sort_order, drive_attachments(*)')
          .eq('campaign_id', loadFrom)
          .order('sort_order', { ascending: true })
        if (cancelled) return
        if (caErr) {
          if (isMissingTableError(caErr)) {
            console.warn('[wizard] campaign_attachments missing — migration 004 not applied?', caErr)
          } else {
            throw caErr
          }
        }
        if (cas && cas.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const initialAtt = cas.map((r: any) => r.drive_attachments as DriveAttachmentRow).filter(Boolean)
          setAttachments(initialAtt)
        }

        // 편집 모드에서 그룹과 개별 연락처 바구니가 둘 다 비어있다 = 원본이 "실패 재발송" 복제본이었거나 수동
        //   수신자 지정 캠페인. recipients 테이블에서 모든 수신자를 그대로 로드해 fixedRecipients 로 사용한다.
        // 재사용 모드(failed): 원본에서 실패한 수신자만 로드.
        //
        // Phase 5 주의:
        //   그룹이 없어도 campaign_contacts 가 있으면 바구니 기반 편집을 유지해야 한다.
        //   (기존엔 gs.length === 0 만 체크 → 개별 연락처만 담은 캠페인 편집 시 바구니 상태가 손실됨)
        const hasBasket =
          (gs && gs.length > 0) || (ccs && ccs.length > 0)
        type RecipientLoadRow = {
          contact_id: string | null
          email: string
          name: string | null
          variables: unknown
          error_message?: string | null
        }
        if (isEditMode) {
          // 부분 발송 캠페인 안내용 — 발송 이력 행 / 개인화 override 행 수
          const [lockedRes, ovRes] = await Promise.all([
            supabase
              .from('recipients')
              .select('id', { count: 'exact', head: true })
              .eq('campaign_id', loadFrom)
              .or('status.neq.pending,gmail_message_id.not.is.null'),
            supabase
              .from('recipients')
              .select('id', { count: 'exact', head: true })
              .eq('campaign_id', loadFrom)
              .or('subject_override.not.is.null,body_html_override.not.is.null'),
          ])
          if (cancelled) return
          if (lockedRes.error) console.warn('[wizard] locked recipient count warn:', lockedRes.error)
          if (ovRes.error) console.warn('[wizard] override recipient count warn:', ovRes.error)
          setLockedRecipientCount(lockedRes.count ?? 0)
          setOverrideRecipientCount(ovRes.count ?? 0)
        }
        if (isEditMode && !hasBasket) {
          // PostgREST max_rows(1000) — 잘리면 저장 시 수신자가 유실되므로 페이지 단위로 전부 읽음
          const { data: rs, error: rErr } = await fetchAllPages<RecipientLoadRow>((from, to) =>
            supabase
              .from('recipients')
              .select('id, contact_id, email, name, variables')
              .eq('campaign_id', loadFrom)
              .order('id', { ascending: true })
              .range(from, to),
          ).then(
            (data) => ({ data, error: null }),
            (error) => ({ data: null, error }),
          )
          if (cancelled) return
          if (rErr) {
            if (isMissingTableError(rErr)) {
              console.warn('[wizard] recipients missing — migration 001 not applied?', rErr)
            } else {
              throw rErr
            }
          }
          const fixed: PreviewContact[] = (rs ?? []).map((r) => {
            const vars = (r.variables ?? {}) as Record<string, string | undefined>
            return {
              id: (r.contact_id as string) ?? '',
              email: r.email as string,
              name: (r.name as string | null) ?? null,
              company: vars.company ?? null,
              department: vars.department ?? null,
              job_title: vars.job_title ?? null,
              job_title_raw: vars.job_title_raw ?? vars.job_title ?? null,
            }
          })
          setFixedRecipients(fixed)
        } else if (!isEditMode && reuseMode === 'failed') {
          const { data: rs, error: rErr } = await fetchAllPages<RecipientLoadRow>((from, to) =>
            supabase
              .from('recipients')
              .select('id, contact_id, email, name, variables, error_message')
              .eq('campaign_id', loadFrom)
              .eq('status', 'failed')
              .order('id', { ascending: true })
              .range(from, to),
          ).then(
            (data) => ({ data, error: null }),
            (error) => ({ data: null, error }),
          )
          if (cancelled) return
          if (rErr) {
            if (isMissingTableError(rErr)) {
              console.warn('[wizard] recipients missing — migration 001 not applied?', rErr)
            } else {
              throw rErr
            }
          }
          // '전송 결과 불확실' 행은 이미 받았을 수 있어 일괄 재발송 대상에서 제외 —
          // 사용자가 Gmail 보낸편지함을 확인한 뒤 개별로 처리해야 한다 (중복 발송 방지).
          const uncertain = (rs ?? []).filter((r) => r.error_message === AMBIGUOUS_SEND_MESSAGE)
          if (uncertain.length > 0) {
            toast.warning(
              `전송 결과가 불확실한 ${uncertain.length}명은 이미 받았을 수 있어 제외했습니다. Gmail 보낸편지함을 확인 후 필요하면 개별로 보내주세요.`,
              { duration: 15000 },
            )
          }
          const fixed: PreviewContact[] = (rs ?? [])
            .filter((r) => r.error_message !== AMBIGUOUS_SEND_MESSAGE)
            .map((r) => {
            const vars = (r.variables ?? {}) as Record<string, string | undefined>
            return {
              id: (r.contact_id as string) ?? '',
              email: r.email as string,
              name: (r.name as string | null) ?? null,
              company: vars.company ?? null,
              department: vars.department ?? null,
              job_title: vars.job_title ?? null,
              job_title_raw: vars.job_title_raw ?? vars.job_title ?? null,
            }
          })
          setFixedRecipients(fixed)
          if (fixed.length === 0) {
            toast.info('실패한 수신자가 없습니다.')
          }
        }
      } catch (e) {
        if (cancelled) return
        // 보조 쿼리 실패 — 핵심 campaigns row 는 이미 로드됐으므로 편집 화면을 유지한다.
        // Supabase 에러는 code / details / hint / message 를 분리해서 찍어야 원인 파악이 쉽다.
        // (예: migration 012 미적용 시 42P01, RLS 차단 시 42501, FK 위반 23503 등)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyErr = e as any
        console.error('[wizard] secondary load failed:', {
          message: anyErr?.message,
          code: anyErr?.code,
          details: anyErr?.details,
          hint: anyErr?.hint,
          raw: e,
        })
        toast.warning(
          `일부 데이터를 불러오지 못했습니다${anyErr?.code ? ` (${anyErr.code})` : ''}: ${
            anyErr?.hint || anyErr?.details || anyErr?.message || '알 수 없는 오류'
          }. 현재 입력값으로 저장하면 이전 상태를 덮어쓰게 되니 주의하세요.`,
        )
        // 의도적으로 navigate 하지 않음 — 사용자가 보이는 필드는 계속 편집할 수 있어야 한다.
      } finally {
        if (!cancelled) setReuseLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reuseFrom, reuseMode, editCampaignId, isEditMode, navigate])

  // Phase 5: 수신자 preview 계산
  //   - fixedRecipients 모드: 조회 없음 (rawUnion 이 그대로 사용)
  //   - 일반 모드: 그룹에서 풀어낸 연락처 ∪ 개별 선택 연락처
  //     → 수신거부/반송 은 양쪽 모두에서 제외, 그룹 경유는 보관(archived) 연락처도 제외
  //     → 이메일 dedupe 는 rawUnion useMemo 에서 (제외 명단 우선 규칙 적용)
  useEffect(() => {
    if (fixedRecipients !== null) {
      setPreviewError(false)
      return
    }
    if (selectedGroupIds.length === 0 && selectedContactIds.length === 0) {
      setFetchedContacts([])
      setPreviewError(false)
      return
    }
    // C5: cleanup guard — 그룹/연락처 선택을 빠르게 바꿀 때 오래된 fetch 가 나중 결과를 덮어쓰는 race 방지
    let cancelled = false
    setLoadingPreview(true)
    ;(async () => {
      type ContactRow = {
        id: string
        email: string
        name: string | null
        company: string | null
        department: string | null
        job_title: string | null
        display_title: string | null
        is_unsubscribed: boolean
        is_bounced: boolean
      }
      const CONTACT_COLS =
        'id, email, name, company, department, job_title, display_title, is_unsubscribed, is_bounced'

      const all: ContactRow[] = []
      try {
        // 1) 그룹 → 연락처 (inner join). PostgREST max_rows(1000) 를 넘는 멤버십도 끝까지 페이지 조회.
        if (selectedGroupIds.length > 0) {
          const rows = await fetchAllPages<{ contacts: ContactRow | null }>((from, to) =>
            supabase
              .from('contact_groups')
              .select(`id, contacts!inner(${CONTACT_COLS})`)
              .in('group_id', selectedGroupIds)
              // 연락처 목록 화면과 같은 기준 — 보관된(1년 이상 비활성) 연락처는 그룹 발송에서 제외
              .is('contacts.archived_at', null)
              .order('id', { ascending: true })
              .range(from, to),
          )
          for (const r of rows) if (r.contacts) all.push(r.contacts)
        }

        // 2) 개별 연락처 직접 조회 — id 목록이 URL 에 실리므로 묶음 단위로 나눠 조회
        for (const ids of chunk(selectedContactIds, IN_FILTER_CHUNK)) {
          const { data, error } = await supabase
            .from('contacts')
            .select(CONTACT_COLS)
            .in('id', ids)
          if (error) throw error
          for (const c of (data ?? []) as ContactRow[]) all.push(c)
        }
      } catch (error) {
        if (cancelled) return
        console.error('[wizard] preview recipient fetch failed:', error)
        toast.error('수신자 조회 실패 — 다시 시도해주세요. (조회가 끝나기 전에는 저장할 수 없습니다)')
        setFetchedContacts([])
        setPreviewError(true)
        setLoadingPreview(false)
        return
      }
      if (cancelled) return

      // 3) id dedupe + 수신거부/반송 제외 (이메일 dedupe 는 rawUnion 에서)
      const byId = new Map<string, PreviewContact>()
      for (const c of all) {
        if (!c || c.is_unsubscribed || c.is_bounced) continue
        if (byId.has(c.id)) continue
        if (!(c.email ?? '').trim()) continue
        // 사용 직책 우선 — 비어있으면 원본 직책 사용. 메일 템플릿 {{job_title}} 가 이 값을 받음.
        const effectiveTitle = c.display_title?.trim() || c.job_title || null
        byId.set(c.id, {
          id: c.id,
          email: c.email,
          name: c.name,
          company: c.company,
          department: c.department,
          job_title: effectiveTitle,
          job_title_raw: c.job_title,
        })
      }

      setPreviewError(false)
      setLoadingPreview(false)
      setFetchedContacts(Array.from(byId.values()))
    })()
    return () => {
      cancelled = true
      // 취소된 fetch 가 loading 을 해제하지 못하고 끝나는 경우 대비 — 다음 effect 가 다시 true 로 세팅
      setLoadingPreview(false)
    }
  }, [selectedGroupIds, selectedContactIds, fixedRecipients])

  // Phase 7: CC / BCC 그룹+개별 연락처 → 이메일 펼치기
  // ccGroupIds / ccContactIds (또는 bcc 버전) 가 바뀔 때마다 DB 에서 이메일을 긁어와
  // ccBasketEmails / bccBasketEmails 캐시를 갱신한다. 최종 resolvedCcEmails /
  // resolvedBccEmails 는 useMemo 로 ccEmails 과 union+dedupe.
  //
  // 주의:
  //   - 수신거부(is_unsubscribed) / 반송(is_bounced) 연락처는 여기서도 조용히 제외
  //   - 동일 contact 가 그룹과 개별에 동시에 있어도 dedupe 로 1 회만 반영
  //   - 조회 실패 시 바구니를 비우고 error 플래그 → 저장 버튼 비활성
  useEffect(() => {
    if (ccGroupIds.length === 0 && ccContactIds.length === 0) {
      setCcBasketEmails([])
      setCcBasketError(false)
      return
    }
    let cancelled = false
    setLoadingCcBasket(true)
    ;(async () => {
      try {
        const emails = await resolveBasketEmails(ccGroupIds, ccContactIds)
        if (cancelled) return
        setCcBasketEmails(emails)
        setCcBasketError(false)
      } catch {
        if (cancelled) return
        toast.error('참조(Cc) 그룹/연락처 조회 실패 — 다시 선택해주세요.')
        setCcBasketEmails([])
        setCcBasketError(true)
      } finally {
        if (!cancelled) setLoadingCcBasket(false)
      }
    })()
    return () => {
      cancelled = true
      setLoadingCcBasket(false)
    }
  }, [ccGroupIds, ccContactIds])

  useEffect(() => {
    if (bccGroupIds.length === 0 && bccContactIds.length === 0) {
      setBccBasketEmails([])
      setBccBasketError(false)
      return
    }
    let cancelled = false
    setLoadingBccBasket(true)
    ;(async () => {
      try {
        const emails = await resolveBasketEmails(bccGroupIds, bccContactIds)
        if (cancelled) return
        setBccBasketEmails(emails)
        setBccBasketError(false)
      } catch {
        if (cancelled) return
        toast.error('숨은참조(Bcc) 그룹/연락처 조회 실패 — 다시 선택해주세요.')
        setBccBasketEmails([])
        setBccBasketError(true)
      } finally {
        if (!cancelled) setLoadingBccBasket(false)
      }
    })()
    return () => {
      cancelled = true
      setLoadingBccBasket(false)
    }
  }, [bccGroupIds, bccContactIds])

  const resolvedCcEmails = useMemo(
    () => dedupeEmails([...ccEmails, ...ccBasketEmails]),
    [ccEmails, ccBasketEmails],
  )
  const resolvedBccEmails = useMemo(
    () => dedupeEmails([...bccEmails, ...bccBasketEmails]),
    [bccEmails, bccBasketEmails],
  )

  // 실제 발송/미리보기에 쓰이는 본문. 사용자 편집이 있으면 그게 우선.
  const effectiveBody = bodyOverride ?? composedHtml

  // 편집/재사용 모드에서 auto-seed 된 bodyOverride 가 블록 재조합 결과와 완전히 동일하면 해제.
  // 이렇게 하면:
  //   - 사용자가 원래 편집한 캠페인 → 블록 재조합과 다름 → override 유지 → "직접 편집됨" 배지 O
  //   - 일반 캠페인(원래 편집 안 함) → 블록 로드 후 composedHtml 과 매칭 → override 자동 해제 → 배지 X
  // 주의: 이 비교는 composedHtml 이 초기 "" 에서 실제 값으로 바뀐 이후에만 의미 있음.
  useEffect(() => {
    if (bodyOverride === null) return
    if (!composedHtml.trim()) return  // 블록/템플릿 로딩 중
    if (composedHtml === bodyOverride) {
      setBodyOverride(null)
      bodyOverrideOriginRef.current = null
    }
  }, [composedHtml, bodyOverride])

  // 편집 모드에서 사용자가 서명을 변경할 때, auto-seed 된 bodyOverride 가 새
  // composedHtml(블록 + 새 서명) 을 가리지 않도록 자동 폐기.
  // 'manual' 편집한 본문은 보존 — 사용자가 이 경우엔 명시적으로 '블록으로 되돌리기'
  // 버튼을 눌러야 한다.
  useEffect(() => {
    if (bodyOverrideOriginRef.current === 'auto' && bodyOverride !== null) {
      setBodyOverride(null)
      bodyOverrideOriginRef.current = null
    }
    // 의도적으로 signatureId 변경에만 반응 — 다른 deps 는 다른 effect 들이 처리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signatureId])

  const usedVariables = useMemo(
    () => Array.from(new Set([...extractVariables(subject), ...extractVariables(effectiveBody)])),
    [subject, effectiveBody]
  )

  // 블록에 포함된 템플릿의 첨부를 자동으로 merge (중복 제거)
  // 사용자가 수동으로 제거했을 수도 있으므로, 새로 추가된 템플릿의 첨부만 append.
  const prevTemplateIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const currentTemplateIds = Array.from(new Set(blocks.map((b) => b.templateId)))
    const prev = prevTemplateIdsRef.current
    const newlyAdded = currentTemplateIds.filter((id) => !prev.has(id))
    if (newlyAdded.length === 0) {
      prevTemplateIdsRef.current = new Set(currentTemplateIds)
      return
    }
    // C6: cleanup guard — 블록을 빠르게 추가/제거할 때 stale fetch 가 attachments 를
    //     덮어쓰는 걸 방지. fetch 가 취소된 경우 ref 갱신도 건너뛰어 다음 effect 에서 재시도 가능.
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('template_attachments')
        .select('drive_attachments(*)')
        .in('template_id', newlyAdded)
      if (cancelled) return
      if (error) {
        console.error('[wizard] template attachments load failed:', error)
        toast.error(`템플릿 첨부 불러오기 실패: ${error.message}`)
        // prevTemplateIdsRef 는 갱신하지 않음 → 다음 렌더에서 재시도 가능
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (data ?? []).map((r: any) => r.drive_attachments as DriveAttachmentRow).filter(Boolean)
      if (rows.length === 0) {
        prevTemplateIdsRef.current = new Set(currentTemplateIds)
        return
      }
      if (cancelled) return
      setAttachments((prevAttachments) => {
        const existing = new Set(prevAttachments.map((a) => a.id))
        const toAdd = rows.filter((r) => !existing.has(r.id))
        return toAdd.length > 0 ? [...prevAttachments, ...toAdd] : prevAttachments
      })
      prevTemplateIdsRef.current = new Set(currentTemplateIds)
    })()
    return () => {
      cancelled = true
    }
  }, [blocks])

  const previewRendered = useMemo(() => {
    const first = previewContacts[0]
    // 수신자가 없어도 미리보기 가능하도록 fallback contact 사용 (편집 중 신규 캠페인 케이스).
    const fallbackContact: PreviewContact = {
      id: '',
      email: 'sample@example.com',
      name: '홍길동',
      company: '주식회사 예시',
      department: '마케팅팀',
      job_title: '팀장',
    }
    const base = first ?? fallbackContact
    // 변수 치환에 빈 문자열이 들어가면 메일에 어색한 공백/구문이 보임.
    // 첫 수신자 데이터 사용하되, NULL/빈 값은 자연스러운 샘플로 치환.
    const vars: Record<string, string> = {
      name: base.name?.trim() || '홍길동',
      email: base.email || 'sample@example.com',
      company: base.company?.trim() || '주식회사 예시',
      department: base.department?.trim() || '마케팅팀',
      job_title: base.job_title?.trim() || '팀장',
    }
    return {
      subject: renderTemplate(subject, vars),
      // 발송 (useSendCampaign) 과 동일하게 HTML 컨텍스트는 이스케이프 치환 — 미리보기/실발송 일치
      html: renderTemplateHtml(effectiveBody, vars),
      contact: base,
      // 샘플 fallback 이 적용된 필드 — UI 가 "예시값 사용 중" 표시 가능
      usedSamples: {
        name: !base.name?.trim(),
        company: !base.company?.trim(),
        department: !base.department?.trim(),
        job_title: !base.job_title?.trim(),
      },
    }
  }, [subject, effectiveBody, previewContacts])

  // 빈 개인화 값 사전 점검 — 미리보기는 샘플 값으로 채워 보이지만 실제 발송은 빈칸으로 나간다.
  // 제목/본문에 쓰인 변수별로 값이 비어 있는 수신자 수와 예시 이메일을 집계.
  const blankFieldStats = useMemo(() => {
    if (usedVariables.length === 0 || previewContacts.length === 0) return []
    const out: Array<{ key: string; count: number; samples: string[] }> = []
    for (const key of usedVariables) {
      let count = 0
      const samples: string[] = []
      for (const c of previewContacts) {
        const v = previewContactVars(c)[key]
        if (v == null || !String(v).trim()) {
          count++
          if (samples.length < 3) samples.push(c.email)
        }
      }
      if (count > 0) out.push({ key, count, samples })
    }
    return out
  }, [usedVariables, previewContacts])

  const insertVariableIntoSubject = (key: string) => setSubject((s) => s + `{{${key}}}`)

  const addBlock = (templateId: string) => {
    const t = templateById.get(templateId)
    if (!t) return
    setBlocks((prev) => [...prev, { key: crypto.randomUUID(), templateId }])
    // updater 밖에서 dispatch — state updater 는 순수해야 함 (StrictMode 이중 호출 안전).
    // "비어있을 때만 채움" 판정이 updater 큐 순서대로 실행되므로 multi-select 시에도
    // 첫 번째 템플릿의 subject 만 채워지는 기존 의미 유지.
    setSubject((s) => (s.trim() ? s : t.subject))
  }

  const removeBlock = (key: string) => {
    setBlocks((prev) => prev.filter((b) => b.key !== key))
  }

  const moveBlock = (key: string, dir: -1 | 1) => {
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.key === key)
      if (idx < 0) return prev
      const next = idx + dir
      if (next < 0 || next >= prev.length) return prev
      const copy = [...prev]
      ;[copy[idx], copy[next]] = [copy[next], copy[idx]]
      return copy
    })
  }

  const handleSubmit = async () => {
    if (!user) return
    if (previewContacts.length === 0) {
      toast.error('수신자가 없습니다.')
      return
    }
    if (blocks.length === 0) {
      toast.error('최소 1개 이상의 블록을 추가해주세요.')
      return
    }
    // 제목은 어느 화면에서도 비어있을 수 있으므로 제출 직전 최종 검증.
    if (!subject.trim()) {
      toast.error('메일 제목을 입력해주세요.')
      return
    }
    // 예약 발송 시각 검증 — datetime-local 파싱 실패나 과거 시각 차단.
    // 서버 cron 이 1분 간격으로 돌아가므로 최소 2분 뒤까지는 여유 권장.
    if (scheduledAt) {
      const t = new Date(scheduledAt).getTime()
      if (isNaN(t)) {
        toast.error('예약 시각이 올바르지 않습니다.')
        return
      }
      if (t < Date.now() + 60_000) {
        toast.error('예약 시각은 현재로부터 최소 1분 이후여야 합니다.')
        return
      }
      // Phase 5: 예약 + 첨부 조합 지원 — 엣지 함수에서 Drive 다운로드/공유 수행.
      // 별도 UI 차단 없음. 큰 첨부는 자동으로 링크 모드로 전환됨.
    }
    const delayToSave = clampDelaySeconds(delaySeconds)
    setSubmitting(true)
    // 편집: 상태를 draft 로 붙잡은 뒤 자식 행을 쓰고, 마지막에만 예약으로 전환한다.
    // 신규: draft 로 만든 뒤 자식 행을 쓰고, 마지막에만 예약으로 전환한다.
    // → 중간 실패 시 수신자 일부만 가진 캠페인이 예약 상태로 남아 자동 발송되는 일이 없다.
    let heldAsDraft = false
    let createdCampaignId: string | null = null
    let completed = false
    // 저장 경로에서 "테이블 없음"(42P01/PGRST205) 으로 skip 한 보조 테이블을 모아뒀다가
    // 완료 직전에 한 번에 경고 토스트로 알려준다. (save 마다 여러 개가 나오면 시끄러우므로)
    // campaigns / campaign_blocks / campaign_attachments / recipients 는 core 로 간주해
    // 실제 실패 시 바로 throw — 이쪽이 없으면 시스템이 작동 불가능한 수준이라 조용한 skip 은 위험.
    const missingAuxTables: string[] = []
    try {
      if (isEditMode && editCampaignId) {
        // ===== 편집 모드: 기존 draft/scheduled 캠페인 덮어쓰기 =====
        // child rows 는 delete→insert 로 교체 (Supabase JS 클라이언트는 트랜잭션 미지원).
        // 0) CAS — 아직 draft/scheduled 일 때만. 그 사이 cron 이 발송을 시작했으면 여기서 중단.
        //    저장하는 동안 cron 이 집어가지 않도록 일단 draft + 예약 해제로 붙잡는다.
        await updateCampaignCas(
          editCampaignId,
          {
            name: name.trim(),
            signature_id: signatureId || null,
            subject: subject.trim(),
            body_html: effectiveBody,
            send_delay_seconds: delayToSave,
            // Phase 7: cc / bcc 는 "직접 입력 + 그룹 멤버 + 개별 연락처" 의
            // union+dedupe 결과를 저장 (발송 시 Gmail 이 그대로 사용).
            cc: resolvedCcEmails,
            bcc: resolvedBccEmails,
            send_mode: sendMode,
            followup_sequence_id: followupSequenceId,
            enable_open_tracking: enableTracking,
            include_unsubscribe_link: includeUnsubscribeLink,
            status: 'draft',
            scheduled_at: null,
          },
          ['draft', 'scheduled'],
        )
        heldAsDraft = true

        // 1) blocks 교체
        {
          const { error: delErr } = await supabase
            .from('campaign_blocks')
            .delete()
            .eq('campaign_id', editCampaignId)
          if (delErr) throw delErr
          const blockRows = blocks.map((b, i) => ({
            campaign_id: editCampaignId,
            template_id: b.templateId,
            position: i,
          }))
          const { error: insErr } = await supabase.from('campaign_blocks').insert(blockRows)
          if (insErr) throw insErr
        }

        // 2) groups 교체 (fixedRecipients 모드에서는 groups 비움)
        {
          const { error: delErr } = await supabase
            .from('campaign_groups')
            .delete()
            .eq('campaign_id', editCampaignId)
          if (delErr) throw delErr
          if (fixedRecipients === null && selectedGroupIds.length > 0) {
            const { error: insErr } = await supabase.from('campaign_groups').insert(
              selectedGroupIds.map((group_id) => ({ campaign_id: editCampaignId, group_id }))
            )
            if (insErr) throw insErr
          }
        }

        // 2-b) Phase 5: 개별 연락처 바구니 교체 (fixedRecipients 모드에선 비움)
        // migration 009 미적용 시 42P01/PGRST205 → skip + 경고 (campaigns 는 이미 최종 이메일
        // 리스트로 저장되므로 발송은 정상 동작, 개별 연락처 바구니 복원만 안 됨)
        {
          const { error: delErr } = await supabase
            .from('campaign_contacts')
            .delete()
            .eq('campaign_id', editCampaignId)
          if (delErr) {
            if (isMissingTableError(delErr)) {
              console.warn('[wizard] campaign_contacts missing on save (migration 009?)', delErr)
              missingAuxTables.push('campaign_contacts')
            } else {
              throw delErr
            }
          } else if (fixedRecipients === null && selectedContactIds.length > 0) {
            const { error: insErr } = await supabase.from('campaign_contacts').insert(
              selectedContactIds.map((contact_id) => ({ campaign_id: editCampaignId, contact_id }))
            )
            if (insErr) {
              if (isMissingTableError(insErr)) {
                console.warn('[wizard] campaign_contacts missing on insert', insErr)
                missingAuxTables.push('campaign_contacts')
              } else {
                throw insErr
              }
            }
          }
        }

        // 2-c) Phase 6 (B): 제외 명단 교체
        // 현재 선택에서 조회된 연락처(이메일 중복 사본 포함)에 해당하는 exclusions 만 저장 —
        // 그룹이 바뀌어 더 이상 후보에 없는 고아(orphan) 제외는 자동 정리.
        // migration 010 미적용 시 동일하게 skip + 경고.
        {
          const { error: delErr } = await supabase
            .from('campaign_exclusions')
            .delete()
            .eq('campaign_id', editCampaignId)
          if (delErr) {
            if (isMissingTableError(delErr)) {
              console.warn('[wizard] campaign_exclusions missing on save (migration 010?)', delErr)
              missingAuxTables.push('campaign_exclusions')
            } else {
              throw delErr
            }
          } else if (fixedRecipients === null && excludedContactIds.length > 0) {
            const validExclusions = excludedContactIds.filter(
              (id) => id && fetchedContactIds.has(id)
            )
            if (validExclusions.length > 0) {
              const { error: insErr } = await supabase.from('campaign_exclusions').insert(
                validExclusions.map((contact_id) => ({
                  campaign_id: editCampaignId,
                  contact_id,
                }))
              )
              if (insErr) {
                if (isMissingTableError(insErr)) {
                  console.warn('[wizard] campaign_exclusions missing on insert', insErr)
                  missingAuxTables.push('campaign_exclusions')
                } else {
                  throw insErr
                }
              }
            }
          }
        }

        // 2-d) Phase 7: CC / BCC 바구니 메타 교체
        // campaigns.cc / campaigns.bcc 는 위 update 에서 최종 이메일 배열로 저장됐고,
        // 여기서는 "어떤 그룹/개별 연락처를 골랐는지" 만 관계 테이블에 기록한다.
        // 이 메타는 편집 모드에서 UI 를 복원할 때 쓰이며, 발송 경로에는 관여하지 않는다.
        const ccRes = await replaceCcBccRows(editCampaignId, 'cc', ccGroupIds, ccContactIds)
        const bccRes = await replaceCcBccRows(editCampaignId, 'bcc', bccGroupIds, bccContactIds)
        if (
          (ccRes.missingTable || bccRes.missingTable) &&
          (ccGroupIds.length + ccContactIds.length + bccGroupIds.length + bccContactIds.length > 0)
        ) {
          toast.warning(
            'CC/BCC 의 그룹·연락처 선택 기록이 저장되지 않았습니다. 마이그레이션 012 를 적용하면 편집 시 복원됩니다. (발송에는 영향 없음)'
          )
        }

        // 3) attachments 교체 — delivery_mode 는 발송 시점에 결정되므로 NULL
        {
          const { error: delErr } = await supabase
            .from('campaign_attachments')
            .delete()
            .eq('campaign_id', editCampaignId)
          if (delErr) throw delErr
          if (attachments.length > 0) {
            const attRows = attachments.map((a, i) => ({
              campaign_id: editCampaignId,
              attachment_id: a.id,
              sort_order: i,
              delivery_mode: null as 'attachment' | 'link' | null,
            }))
            const { error: insErr } = await supabase.from('campaign_attachments').insert(attRows)
            if (insErr) throw insErr
          }
        }

        // 4) recipients — 발송 이력(sent/failed/bounced/skipped/sending 또는 gmail_message_id 있음)
        //    행은 절대 건드리지 않는다. 지우면 발송 이력·오픈/클릭이 cascade 삭제되고,
        //    pending 으로 다시 넣으면 이미 받은 사람에게 또 발송된다.
        //    AI 개인화 subject_override / body_html_override 는 재삽입 시 보존.
        {
          type ExistingRow = {
            id: string
            contact_id: string | null
            email: string
            status: string
            gmail_message_id: string | null
            subject_override: string | null
            body_html_override: string | null
          }
          const existing = await fetchAllPages<ExistingRow>((from, to) =>
            supabase
              .from('recipients')
              .select('id, contact_id, email, status, gmail_message_id, subject_override, body_html_override')
              .eq('campaign_id', editCampaignId)
              .order('id', { ascending: true })
              .range(from, to),
          )
          const lower = (e: string | null | undefined) => (e ?? '').trim().toLowerCase()
          const isPendingRow = (r: ExistingRow) => r.status === 'pending' && !r.gmail_message_id
          const lockedEmails = new Set(existing.filter((r) => !isPendingRow(r)).map((r) => lower(r.email)))
          const pendingRows = existing.filter(isPendingRow)

          const toRow = (c: PreviewContact) => ({
            campaign_id: editCampaignId,
            contact_id: c.id || null,
            email: c.email,
            name: c.name,
            variables: {
              name: c.name ?? '',
              email: c.email,
              company: c.company ?? '',
              department: c.department ?? '',
              job_title: c.job_title ?? '',
              job_title_raw: c.job_title_raw ?? c.job_title ?? '',
            },
            status: 'pending' as const,
          })
          const insertBatches = async (rows: Array<Record<string, unknown>>) => {
            for (const part of chunk(rows, 500)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { error: insErr } = await supabase.from('recipients').insert(part as any)
              if (insErr) throw insErr
            }
          }

          if (lockedEmails.size === 0) {
            // 전원 미발송 — pending 전체 교체 (연락처 최신값으로 스냅샷 갱신)
            const overrideMap = new Map<string, {
              subject_override: string | null
              body_html_override: string | null
            }>()
            for (const r of pendingRows) {
              if (!r.subject_override && !r.body_html_override) continue
              const key = r.contact_id ?? `email:${r.email}`
              overrideMap.set(key, {
                subject_override: r.subject_override,
                body_html_override: r.body_html_override,
              })
            }
            const { error: delErr } = await supabase
              .from('recipients')
              .delete()
              .eq('campaign_id', editCampaignId)
              .eq('status', 'pending')
              .is('gmail_message_id', null)
            if (delErr) throw delErr
            await insertBatches(
              previewContacts.map((c) => {
                // c.id 는 "contact 없음" 을 '' 로 표현하므로 ?? 가 아니라 || 로 판정 —
                // ?? 를 쓰면 key 가 '' 이 되어 email 키로 저장된 개인화 오버라이드를
                // 못 찾고 조용히 소실됨 (저장 시 contact_id 도 || 사용).
                const ov = overrideMap.get(c.id || `email:${c.email}`)
                return {
                  ...toRow(c),
                  ...(ov && {
                    subject_override: ov.subject_override,
                    body_html_override: ov.body_html_override,
                  }),
                }
              }),
            )
          } else {
            // 부분 발송 캠페인 — pending 행만 diff. 선택에서 빠진 pending 행 삭제,
            // 아직 행이 없는 이메일만 추가 (대소문자 무시). 남는 pending 행은 그대로 둔다.
            const selectedEmails = new Set(previewContacts.map((c) => lower(c.email)))
            const removeIds = pendingRows
              .filter((r) => !selectedEmails.has(lower(r.email)))
              .map((r) => r.id)
            for (const ids of chunk(removeIds, IN_FILTER_CHUNK)) {
              const { error: delErr } = await supabase
                .from('recipients')
                .delete()
                .in('id', ids)
                .eq('status', 'pending')
                .is('gmail_message_id', null)
              if (delErr) throw delErr
            }
            const haveEmails = new Set([
              ...lockedEmails,
              ...pendingRows.filter((r) => selectedEmails.has(lower(r.email))).map((r) => lower(r.email)),
            ])
            const seen = new Set<string>()
            const additions = previewContacts.filter((c) => {
              const em = lower(c.email)
              if (!em || haveEmails.has(em) || seen.has(em)) return false
              seen.add(em)
              return true
            })
            await insertBatches(additions.map(toRow))
          }
        }

        // 5) 최종 — total_count 를 실제 행 수로 맞추고, 자식 행을 모두 쓴 뒤에만 예약으로 전환.
        {
          const { count, error: cntErr } = await supabase
            .from('recipients')
            .select('id', { count: 'exact', head: true })
            .eq('campaign_id', editCampaignId)
          if (cntErr) throw cntErr
          await updateCampaignCas(
            editCampaignId,
            {
              total_count: count ?? previewContacts.length,
              status: scheduledAt ? 'scheduled' : 'draft',
              scheduled_at: scheduledAt,
            },
            ['draft'],
          )
          completed = true
        }

        // campaigns 와 다른 key space 를 쓰는 child 쿼리들도 명시적으로 무효화해야
        // Detail 페이지로 돌아갔을 때 옛 블록/첨부가 잠깐이라도 보이지 않는다.
        qc.invalidateQueries({ queryKey: ['campaigns'] })
        qc.invalidateQueries({ queryKey: ['campaign-blocks', editCampaignId] })
        qc.invalidateQueries({ queryKey: ['campaign_attachments', editCampaignId] })

        // migration 미적용으로 skip 된 보조 테이블이 있으면 1회 안내 (발송은 정상)
        if (missingAuxTables.length > 0) {
          const unique = Array.from(new Set(missingAuxTables))
          toast.warning(
            `일부 보조 테이블(${unique.join(', ')})이 DB 에 없어 해당 상태는 저장되지 않았습니다. ` +
              '관련 migration 을 적용하면 다음 편집부터 복원됩니다. (발송에는 영향 없음)',
          )
        }

        toast.success(
          scheduledAt
            ? `${new Date(scheduledAt).toLocaleString('ko-KR')} 예약으로 저장되었습니다.`
            : '메일 발송이 저장되었습니다.',
        )
        navigate(`/campaigns/${editCampaignId}`)
      } else {
        // ===== 신규 생성 모드 (재사용/복제 포함) =====
        // 1) 캠페인 생성 — body_html 은 작성 시점 스냅샷으로 저장
        const campaign = await createCampaign.mutateAsync({
          name: name.trim(),
          template_id: null,
          signature_id: signatureId || null,
          subject: subject.trim(),
          body_html: effectiveBody,
          // 예약이어도 일단 draft 로 생성 — 수신자를 다 넣은 뒤 마지막에 예약으로 전환
          status: 'draft',
          scheduled_at: null,
          total_count: previewContacts.length,
          send_delay_seconds: delayToSave,
          // Phase 7: 최종 union+dedupe 이메일 배열 — 발송 경로(useSendCampaign)가 이 값 사용
          cc: resolvedCcEmails,
          bcc: resolvedBccEmails,
          send_mode: sendMode,
          followup_sequence_id: followupSequenceId,
          enable_open_tracking: enableTracking,
          include_unsubscribe_link: includeUnsubscribeLink,
        })

        createdCampaignId = campaign.id

        // 2) campaign_blocks
        const blockRows = blocks.map((b, i) => ({
          campaign_id: campaign.id,
          template_id: b.templateId,
          position: i,
        }))
        const { error: bErr } = await supabase.from('campaign_blocks').insert(blockRows)
        if (bErr) throw bErr

        // 3) campaign_groups — 실패 재발송 모드에서는 수신자를 직접 지정하므로 그룹 연결 skip
        if (fixedRecipients === null && selectedGroupIds.length > 0) {
          const { error: cgErr } = await supabase.from('campaign_groups').insert(
            selectedGroupIds.map((group_id) => ({ campaign_id: campaign.id, group_id }))
          )
          if (cgErr) throw cgErr
        }

        // 3-b) Phase 5: 개별 연락처 바구니 저장
        // migration 009 미적용 시 skip + 경고 (campaigns.cc 는 최종 이메일로 저장되므로 발송 무관)
        if (fixedRecipients === null && selectedContactIds.length > 0) {
          const { error: ccErr } = await supabase.from('campaign_contacts').insert(
            selectedContactIds.map((contact_id) => ({ campaign_id: campaign.id, contact_id }))
          )
          if (ccErr) {
            if (isMissingTableError(ccErr)) {
              console.warn('[wizard] campaign_contacts missing on create (migration 009?)', ccErr)
              missingAuxTables.push('campaign_contacts')
            } else {
              throw ccErr
            }
          }
        }

        // 3-c) Phase 6 (B): 제외 명단 저장 — 현재 후보에 속한 것만 저장 (orphan 정리)
        if (fixedRecipients === null && excludedContactIds.length > 0) {
          const validExclusions = excludedContactIds.filter(
            (id) => id && fetchedContactIds.has(id)
          )
          if (validExclusions.length > 0) {
            const { error: exErr } = await supabase.from('campaign_exclusions').insert(
              validExclusions.map((contact_id) => ({
                campaign_id: campaign.id,
                contact_id,
              }))
            )
            if (exErr) {
              if (isMissingTableError(exErr)) {
                console.warn('[wizard] campaign_exclusions missing on create (migration 010?)', exErr)
                missingAuxTables.push('campaign_exclusions')
              } else {
                throw exErr
              }
            }
          }
        }

        // 3-d) Phase 7: CC / BCC 바구니 메타 저장 — 편집 시 UI 복원용.
        // campaigns.cc / campaigns.bcc 는 위 createCampaign 에서 최종 이메일 배열로
        // 이미 저장됐고, 여기선 "어떤 그룹/개별 연락처를 골랐는지" 관계만 기록.
        const ccResCreate = await replaceCcBccRows(campaign.id, 'cc', ccGroupIds, ccContactIds)
        const bccResCreate = await replaceCcBccRows(campaign.id, 'bcc', bccGroupIds, bccContactIds)
        if (
          (ccResCreate.missingTable || bccResCreate.missingTable) &&
          (ccGroupIds.length + ccContactIds.length + bccGroupIds.length + bccContactIds.length > 0)
        ) {
          toast.warning(
            'CC/BCC 의 그룹·연락처 선택 기록이 저장되지 않았습니다. 마이그레이션 012 를 적용하면 편집 시 복원됩니다. (발송에는 영향 없음)'
          )
        }

        // 4) campaign_attachments — 발송 시점에 delivery_mode 결정되므로 draft 단계는 NULL
        if (attachments.length > 0) {
          const attRows = attachments.map((a, i) => ({
            campaign_id: campaign.id,
            attachment_id: a.id,
            sort_order: i,
            delivery_mode: null as 'attachment' | 'link' | null,
          }))
          const { error: caErr } = await supabase.from('campaign_attachments').insert(attRows)
          if (caErr) throw caErr
        }

        // 5) recipients (배치)
        const BATCH = 500
        for (let i = 0; i < previewContacts.length; i += BATCH) {
          const chunk = previewContacts.slice(i, i + BATCH)
          const rows = chunk.map((c) => ({
            campaign_id: campaign.id,
            contact_id: c.id || null,
            email: c.email,
            name: c.name,
            variables: {
              name: c.name ?? '',
              email: c.email,
              company: c.company ?? '',
              department: c.department ?? '',
              // job_title 은 사용 직책 우선 적용된 값 — 메일 템플릿 {{job_title}} 가 받음
              job_title: c.job_title ?? '',
              // 원본 직책도 함께 보관 — 필요하면 {{job_title_raw}} 로 호출
              job_title_raw: c.job_title_raw ?? c.job_title ?? '',
            },
            status: 'pending' as const,
          }))
          const { error: rErr } = await supabase.from('recipients').insert(rows)
          if (rErr) throw rErr
        }

        // 6) 수신자까지 모두 저장된 뒤에만 예약으로 전환 (pg_cron 이 자동 발송)
        if (scheduledAt) {
          await updateCampaignCas(
            campaign.id,
            { status: 'scheduled', scheduled_at: scheduledAt, last_error: null },
            ['draft'],
          )
        }
        completed = true

        // migration 미적용으로 skip 된 보조 테이블이 있으면 1회 안내 (발송은 정상)
        if (missingAuxTables.length > 0) {
          const unique = Array.from(new Set(missingAuxTables))
          toast.warning(
            `일부 보조 테이블(${unique.join(', ')})이 DB 에 없어 해당 상태는 저장되지 않았습니다. ` +
              '관련 migration 을 적용하면 다음 편집부터 복원됩니다. (발송에는 영향 없음)',
          )
        }

        toast.success(
          scheduledAt
            ? `${new Date(scheduledAt).toLocaleString('ko-KR')} 에 자동 발송되도록 예약됐습니다.`
            : '메일 발송이 생성되었습니다.',
        )
        navigate(`/campaigns/${campaign.id}`)
      }
    } catch (e) {
      // Supabase 에러는 code / details / hint / message 를 분리해서 찍어야 원인 파악이 쉽다.
      // 예: FK 위반 / RLS 차단 / NOT NULL / UNIQUE / migration 미적용 등
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyErr = e as any
      console.error('[wizard] submit failed:', {
        message: anyErr?.message,
        code: anyErr?.code,
        details: anyErr?.details,
        hint: anyErr?.hint,
        raw: e,
      })
      // 사용자용 메시지: 가장 유의미한 필드 우선 (hint 는 PostgREST 가 해결책을 제안할 때만 옴)
      const baseMsg =
        e instanceof CampaignStatusConflictError
          ? '발송이 이미 시작되었거나 완료되어 저장할 수 없습니다. 상세 화면에서 상태를 확인해주세요.'
          : anyErr?.hint ||
            anyErr?.details ||
            anyErr?.message ||
            (isEditMode ? '메일 발송 저장 실패' : '메일 발송 생성 실패')
      // 신규: 반쯤 만들어진 draft 는 지운다 (재시도 시 중복 캠페인 방지). 위저드 입력값은 그대로 남아 있음.
      if (!completed && createdCampaignId) {
        const { error: cleanupErr } = await supabase
          .from('campaigns')
          .delete()
          .eq('id', createdCampaignId)
          .eq('status', 'draft')
        if (cleanupErr) console.warn('[wizard] partial campaign cleanup failed:', cleanupErr)
        qc.invalidateQueries({ queryKey: ['campaigns'] })
      }
      const suffix =
        !completed && heldAsDraft
          ? ' — 캠페인은 초안 상태로 보류되었습니다 (예약 해제). 다시 저장해주세요.'
          : ''
      toast.error(`${baseMsg}${suffix}`, { duration: suffix ? 10000 : undefined })
      if (heldAsDraft) qc.invalidateQueries({ queryKey: ['campaigns'] })
    } finally {
      setSubmitting(false)
    }
  }

  // 우측 미리보기 패널 — 본문 직접 편집 토글 + 도메인 검증 상태
  const [editingBody, setEditingBody] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const validateEmails = useValidateEmails()
  const { data: sequenceOptions = [] } = useSequenceOptions()

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => navigate('/campaigns')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-xl font-bold min-w-0 truncate">
            {isEditMode
              ? '메일 발송 편집'
              : reuseMode === 'failed'
                ? '실패 수신자 재발송'
                : reuseMode === 'all'
                  ? '메일 발송 복제'
                  : '새 메일 발송'}
          </h1>
          {reuseSourceName && (
            <Badge variant="secondary" className="text-xs truncate max-w-[200px]">
              {isEditMode ? '편집 중' : '원본'}: {reuseSourceName}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          수신자·콘텐츠·발송 설정을 한 화면에서 작성하고, 우측 미리보기는 변수 ({'{{name}}'}, {'{{company}}'} 등)
          를 첫 수신자 정보 (없으면 샘플) 로 치환해 실시간 표시됩니다.
        </p>
      </div>

      {/* lg 미만: 폼 위 + 미리보기 아래로 세로 스택 (페이지 전체 스크롤).
          lg 이상: 좌우 2컬럼 (각 패널 독립 스크롤). */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
        {/* ── LEFT: Form pane ── */}
        <div className="flex-1 lg:overflow-y-auto">
          <div className="max-w-[600px] mx-auto p-4 sm:p-6 space-y-8">
            {reuseLoading && (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
            {!reuseLoading && (
              <>
                {/* 편집 모드 — 부분 발송 / 개인화 override 안내 */}
                {isEditMode && (lockedRecipientCount > 0 || overrideRecipientCount > 0) && (
                  <Card className="border-amber-300 bg-amber-50/50 dark:border-amber-800/60 dark:bg-amber-950/20">
                    <CardContent className="p-3 space-y-1 text-xs text-amber-900 dark:text-amber-200">
                      {lockedRecipientCount > 0 && (
                        <p>
                          이미 발송 처리된(성공·실패·반송 등) 수신자 {lockedRecipientCount.toLocaleString()}명은 그대로 유지되며
                          다시 발송되지 않습니다. 수신자 추가·제외는 아직 발송되지 않은 대상에만 적용됩니다.
                        </p>
                      )}
                      {overrideRecipientCount > 0 && (
                        <p>
                          개인화(AI) 제목/본문이 지정된 수신자 {overrideRecipientCount.toLocaleString()}명은 아래 제목·본문 대신
                          개인화 내용이 그대로 발송됩니다.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* 수신자 */}
                <Step1
                  name={name}
                  setName={setName}
                  groups={groups}
                  selectedGroupIds={selectedGroupIds}
                  setSelectedGroupIds={setSelectedGroupIds}
                  selectedContactIds={selectedContactIds}
                  setSelectedContactIds={setSelectedContactIds}
                  previewContacts={previewContacts}
                  loadingPreview={loadingPreview}
                  fixedRecipients={fixedRecipients}
                  excludedContactIds={excludedContactIds}
                  setExcludedContactIds={setExcludedContactIds}
                  excludedMeta={excludedMeta}
                />

                {/* 콘텐츠 */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground shrink-0">콘텐츠</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                  <Step2
                    templates={templates}
                    signatures={signatures}
                    signatureId={signatureId}
                    setSignatureId={setSignatureId}
                    subject={subject}
                    setSubject={setSubject}
                    blocks={blocks}
                    templateById={templateById}
                    onAddBlock={addBlock}
                    onRemoveBlock={removeBlock}
                    onMoveBlock={moveBlock}
                    insertSubject={insertVariableIntoSubject}
                    usedVariables={usedVariables}
                    attachments={attachments}
                    setAttachments={setAttachments}
                    groups={groups}
                    ccEmails={ccEmails}
                    setCcEmails={setCcEmails}
                    ccGroupIds={ccGroupIds}
                    setCcGroupIds={setCcGroupIds}
                    ccContactIds={ccContactIds}
                    setCcContactIds={setCcContactIds}
                    resolvedCcEmails={resolvedCcEmails}
                    loadingCcBasket={loadingCcBasket}
                    bccEmails={bccEmails}
                    setBccEmails={setBccEmails}
                    bccGroupIds={bccGroupIds}
                    setBccGroupIds={setBccGroupIds}
                    bccContactIds={bccContactIds}
                    setBccContactIds={setBccContactIds}
                    resolvedBccEmails={resolvedBccEmails}
                    loadingBccBasket={loadingBccBasket}
                    recipientEmails={recipientEmails}
                    sendMode={sendMode}
                    setSendMode={setSendMode}
                    recipientCount={previewContacts.length}
                  />
                </div>

                {/* 발송 설정 */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground shrink-0">발송 설정</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  {sendMode === 'individual' && (
                    <div className="space-y-1.5">
                      <Label>발송 간격 (초)</Label>
                      <Input
                        type="number"
                        min={0}
                        max={MAX_SEND_DELAY_SECONDS}
                        value={delaySeconds}
                        onChange={(e) => setDelaySeconds(clampDelaySeconds(Number(e.target.value)))}
                        className="max-w-[120px]"
                      />
                      <p className="text-xs text-muted-foreground">
                        메일 사이 대기 시간 (0–{MAX_SEND_DELAY_SECONDS}초). 간격을 늘려도 Gmail 일일 한도는
                        줄지 않으며, 너무 길면 서버 발송이 크게 느려집니다. 보통 3–10초면 충분합니다.
                      </p>
                    </div>
                  )}

                  {/* 오픈/클릭 트래킹 토글 */}
                  <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <Label className="text-sm">오픈·클릭 추적</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        메일 열람(픽셀)과 본문 링크 클릭을 추적해 분석에 표시합니다.
                        {sendMode === 'bulk' && ' (일괄 발송 모드에서는 수신자별 추적이 불가해 적용되지 않습니다.)'}
                      </p>
                    </div>
                    <Switch
                      checked={enableTracking}
                      onCheckedChange={setEnableTracking}
                      disabled={sendMode === 'bulk'}
                    />
                  </div>

                  {/* 수신거부 링크 토글 (079) */}
                  <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <Label htmlFor="include-unsubscribe-link" className="text-sm">
                        수신거부 링크 포함 (권장 · 광고성 메일은 법적 의무)
                      </Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {sendMode === 'bulk'
                          ? "메일 하단에 '수신거부'라고 회신해 달라는 안내를 붙입니다. (한 번에 보내기는 수신자별 링크를 넣을 수 없습니다.)"
                          : '메일 하단에 수신자별 수신거부 링크를 붙이고, Gmail 등의 원클릭 수신거부 헤더를 추가합니다.'}
                        {!includeUnsubscribeLink &&
                          ' 끄면 수신거부 방법이 본문에 표시되지 않습니다 — 광고성 메일에는 사용하지 마세요.'}
                      </p>
                    </div>
                    <Switch
                      id="include-unsubscribe-link"
                      checked={includeUnsubscribeLink}
                      onCheckedChange={setIncludeUnsubscribeLink}
                    />
                  </div>

                  <ScheduleSection
                    scheduledAt={scheduledAt}
                    setScheduledAt={setScheduledAt}
                    hasAttachments={attachments.length > 0}
                  />

                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1.5">
                      <RotateCcw className="w-3.5 h-3.5" />
                      후속 시퀀스 <span className="text-xs font-normal text-muted-foreground">(선택)</span>
                    </Label>
                    <Select
                      value={followupSequenceId ?? '__none__'}
                      onValueChange={(v) => setFollowupSequenceId(v === '__none__' ? null : v)}
                    >
                      <SelectTrigger className="max-w-[360px]">
                        <SelectValue placeholder="후속 없음" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">후속 없음</SelectItem>
                        {sequenceOptions.map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      발송 후, 회신·수신거부·반송이 없는 수신자에게 이 시퀀스가 같은 메일 스레드로 자동 후속 발송합니다.
                      {sequenceOptions.length === 0 && ' (활성 시퀀스가 없습니다 — 시퀀스 메뉴에서 먼저 만들어주세요.)'}
                    </p>
                  </div>
                </div>

                {/* 편집 모드: 최종 수신자 검토 */}
                {isEditMode && (
                  <FinalRecipientReview
                    previewContacts={finalReviewContacts}
                    excludedContactIds={excludedContactIds}
                    setExcludedContactIds={setExcludedContactIds}
                    selectedContactIds={selectedContactIds}
                    setSelectedContactIds={setSelectedContactIds}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* ── RIGHT: Preview pane (lg 이상은 우측, 미만은 폼 아래로 스택) ── */}
        <div className="flex flex-col w-full lg:w-[420px] xl:w-[480px] shrink-0 lg:overflow-y-auto border-t lg:border-t-0 lg:border-l bg-muted/20">
          {!reuseLoading && (
            <div className="p-4 space-y-3">
              {/* Compact summary card */}
              <Card>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={sendMode === 'bulk' ? 'default' : 'secondary'}>
                      <Send className="w-3 h-3 mr-1" />
                      {sendMode === 'bulk' ? '한 번에 보내기' : '개별 발송'}
                    </Badge>
                    <Badge variant="secondary">
                      <Users className="w-3 h-3 mr-1" />
                      {previewContacts.length}명
                    </Badge>
                    {scheduledAt && (
                      <Badge variant="default" className="bg-blue-600 hover:bg-blue-600">
                        <CalendarClock className="w-3 h-3 mr-1" />
                        {new Date(scheduledAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </Badge>
                    )}
                    {attachments.length > 0 && (
                      <Badge variant={attachments.reduce((s, a) => s + (a.file_size ?? 0), 0) > ATTACHMENT_SAFE_THRESHOLD ? 'default' : 'secondary'}>
                        <Paperclip className="w-3 h-3 mr-1" />
                        첨부 {attachments.length}개
                      </Badge>
                    )}
                    {/* 도메인 검증 */}
                    <Button
                      type="button"
                      size="sm"
                      variant={validation && validation.invalid_emails.length > 0 ? 'destructive' : 'outline'}
                      className="h-6 text-[11px]"
                      onClick={async () => {
                        if (previewContacts.length === 0) return
                        try {
                          const r = await validateEmails.mutateAsync(previewContacts.map((c) => c.email))
                          setValidation(r)
                          if (r.invalid_emails.length === 0) {
                            toast.success(`${r.checked_domains}개 도메인 검증 완료 — 모두 정상`)
                          } else {
                            toast.warning(`반송 가능성 ${r.invalid_emails.length}건 발견`)
                          }
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : '검증 실패')
                        }
                      }}
                      disabled={validateEmails.isPending || previewContacts.length === 0}
                    >
                      {validateEmails.isPending ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />검증 중…</> : validation ? (validation.invalid_emails.length > 0 ? `⚠ 의심 ${validation.invalid_emails.length}건` : `✓ 도메인 OK`) : '도메인 검증'}
                    </Button>
                  </div>
                  {/* Bulk warning */}
                  {sendMode === 'bulk' && (
                    <div className={`text-xs rounded p-2 ${usedVariables.length > 0 ? 'bg-destructive/10 text-destructive' : 'bg-blue-50/60 dark:bg-blue-950/20 text-blue-700 dark:text-blue-300'}`}>
                      {usedVariables.length > 0
                        ? `⚠️ 개인화 변수(${usedVariables.map((v) => `{{${v}}}`).join(', ')})가 있어 한 번에 보내기 불가`
                        : `수신자 ${previewContacts.length}명 전원이 To에 공개되어 1회 발송됩니다.`}
                    </div>
                  )}
                  {/* 빈 개인화 값 — 실제 발송에서는 빈칸으로 나감 */}
                  {sendMode === 'individual' && blankFieldStats.length > 0 && (
                    <div className="text-xs rounded p-2 bg-amber-50/70 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 space-y-0.5">
                      {blankFieldStats.map((b) => (
                        <div key={b.key}>
                          ⚠️ {`{{${b.key}}}`} 값이 비어 있는 수신자 {b.count}명 — 해당 자리는 빈칸으로 발송됩니다
                          {' '}(예: {b.samples.join(', ')}{b.count > b.samples.length ? ' 등' : ''})
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 개별 발송 + CC/BCC — 수신자마다 1통씩 복제됨 */}
                  {sendMode === 'individual' &&
                    previewContacts.length > 1 &&
                    resolvedCcEmails.length + resolvedBccEmails.length > 0 && (
                      <div className="text-xs rounded p-2 bg-amber-50/70 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300">
                        ⚠️ 참조/숨은참조 {resolvedCcEmails.length + resolvedBccEmails.length}개 주소가 수신자{' '}
                        {previewContacts.length}명의 메일마다 포함되어, 주소마다 {previewContacts.length}통씩 받습니다
                        (총 {(previewContacts.length * (1 + resolvedCcEmails.length + resolvedBccEmails.length)).toLocaleString()}명분이
                        Gmail 일일 한도에 집계).
                      </div>
                    )}
                  {/* CC/BCC compact */}
                  {(resolvedCcEmails.length > 0 || resolvedBccEmails.length > 0) && (
                    <div className="text-xs space-y-0.5 pt-1 border-t">
                      {resolvedCcEmails.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <span className="text-muted-foreground shrink-0">Cc:</span>
                          <span className="break-all">{resolvedCcEmails.join(', ')}</span>
                        </div>
                      )}
                      {resolvedBccEmails.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <span className="text-muted-foreground shrink-0">Bcc:</span>
                          <span className="break-all">{resolvedBccEmails.join(', ')}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Invalid emails list */}
                  {validation && validation.invalid_emails.length > 0 && (
                    <div className="text-xs pt-2 border-t">
                      <div className="text-rose-700 dark:text-rose-300 font-medium mb-1">
                        ⚠ 반송 가능성 있는 이메일 ({validation.invalid_emails.length}건)
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {validation.invalid_emails.slice(0, 20).map((e) => (
                          <span key={e} className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 font-mono">{e}</span>
                        ))}
                        {validation.invalid_emails.length > 20 && <span className="text-[10px] text-muted-foreground self-center">+{validation.invalid_emails.length - 20}건 더</span>}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Live preview */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">
                    미리보기 {previewRendered?.contact.email ? `(${previewRendered.contact.email})` : ''}
                  </Label>
                  <div className="flex items-center gap-1.5">
                    {bodyOverride !== null && (
                      <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => { setBodyOverride(null); bodyOverrideOriginRef.current = null }}>
                        <Undo2 className="w-3 h-3 mr-1" />블록으로 되돌리기
                      </Button>
                    )}
                    {editingBody ? (
                      <Button type="button" variant="default" size="sm" className="h-6 text-[11px]" onClick={() => setEditingBody(false)}>
                        <Check className="w-3 h-3 mr-1" />완료
                      </Button>
                    ) : (
                      <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => setEditingBody(true)}>
                        <Pencil className="w-3 h-3 mr-1" />본문 수정
                      </Button>
                    )}
                  </div>
                </div>
                {previewRendered ? (
                  <Card>
                    <CardContent className="p-0">
                      <div className="px-3 py-2.5 border-b bg-muted/30 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">제목</span>
                          {bodyOverride !== null && (
                            <Badge variant="secondary" className="text-[10px] py-0">본문 직접 편집됨</Badge>
                          )}
                        </div>
                        <div className="text-sm font-medium leading-snug">{previewRendered.subject || '(제목 없음)'}</div>
                        {previewRendered.usedSamples && Object.values(previewRendered.usedSamples).some(Boolean) && (
                          <div className="text-[11px] text-amber-700 dark:text-amber-400">
                            💡 미리보기 전용 샘플 값 (실제 발송은 빈칸): {[
                              previewRendered.usedSamples.name && '이름=홍길동',
                              previewRendered.usedSamples.company && '회사=주식회사 예시',
                              previewRendered.usedSamples.department && '부서=마케팅팀',
                              previewRendered.usedSamples.job_title && '직책=팀장',
                            ].filter(Boolean).join(', ')}
                          </div>
                        )}
                      </div>
                      {editingBody ? (
                        <div className="p-3 space-y-2 bg-muted/10">
                          <p className="text-xs text-muted-foreground">
                            합쳐진 본문을 직접 편집합니다. {`{{name}}`} 같은 개인화 변수는 발송 시 각 수신자에 맞춰 치환됩니다.
                          </p>
                          <TipTapEditor
                            value={effectiveBody}
                            onChange={(html) => { setBodyOverride(html); bodyOverrideOriginRef.current = 'manual' }}
                            placeholder="본문을 입력하세요"
                          />
                        </div>
                      ) : (
                        <div className="bg-white dark:bg-gray-950">
                          <SignaturePreview html={previewRendered.html} />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ) : (
                  <div className="rounded-lg border border-dashed p-8 text-center">
                    <p className="text-sm text-muted-foreground">수신자와 콘텐츠를 선택하면<br/>미리보기가 여기에 표시됩니다.</p>
                  </div>
                )}
                {usedVariables.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-xs text-muted-foreground">사용된 변수:</span>
                    {usedVariables.map((v) => (
                      <Badge key={v} variant="secondary" className="text-[10px]">{`{{${v}}}`}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="px-4 sm:px-6 py-3 border-t flex items-center justify-between bg-card">
        <Button
          variant="outline"
          onClick={() => navigate('/campaigns')}
          disabled={submitting}
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          취소
        </Button>

        <Button
          onClick={handleSubmit}
          disabled={
            submitting ||
            reuseLoading ||
            // 수신자 / CC·BCC 조회가 끝나지 않았거나 실패했으면 낡은 목록이 저장되므로 금지
            loadingPreview ||
            loadingCcBasket ||
            loadingBccBasket ||
            previewError ||
            ccBasketError ||
            bccBasketError ||
            previewContacts.length === 0 ||
            !subject.trim() ||
            blocks.length === 0 ||
            // bulk 모드인데 개인화 변수가 남아있거나 수신자가 Gmail 상한을 초과하면 저장 금지
            (sendMode === 'bulk' && usedVariables.length > 0) ||
            (sendMode === 'bulk' && previewContacts.length > 500)
          }
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              {isEditMode ? '저장 중...' : scheduledAt ? '예약 중...' : '생성 중...'}
            </>
          ) : (
            <>
              {scheduledAt ? <CalendarClock className="w-4 h-4 mr-1" /> : <Check className="w-4 h-4 mr-1" />}
              {isEditMode
                ? scheduledAt ? '예약 저장' : '저장'
                : scheduledAt ? '예약 발송 설정' : '초안 생성'}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

type GroupOpt = { id: string; name: string; color: string | null; member_count: number }

// Phase 5: Step1 은 이제 name 입력 + RecipientBasket (그룹 + 개별 연락처) 조합.
// fixedRecipients 모드(실패 재발송 / 편집모드 recipient-only) 에서는 기존 카드 그대로.
// Phase 6 (B): 제외 명단(excludedContactIds) 도 함께 전달 — RecipientBasket 이 UI 렌더.
function Step1({
  name,
  setName,
  groups,
  selectedGroupIds,
  setSelectedGroupIds,
  selectedContactIds,
  setSelectedContactIds,
  previewContacts,
  loadingPreview,
  fixedRecipients,
  excludedContactIds,
  setExcludedContactIds,
  excludedMeta,
}: {
  name: string
  setName: (v: string) => void
  groups: GroupOpt[]
  selectedGroupIds: string[]
  setSelectedGroupIds: (ids: string[]) => void
  selectedContactIds: string[]
  setSelectedContactIds: (ids: string[]) => void
  previewContacts: PreviewContact[]
  loadingPreview: boolean
  fixedRecipients: PreviewContact[] | null
  excludedContactIds: string[]
  setExcludedContactIds: (ids: string[]) => void
  excludedMeta: PreviewContact[]
}) {
  const isFixed = fixedRecipients !== null

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>
          메일 발송 이름 <span className="text-destructive">*</span>
        </Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 4월 뉴스레터"
        />
        <p className="text-xs text-muted-foreground">
          내부 관리용 이름입니다. 수신자에게는 표시되지 않습니다.
        </p>
      </div>

      {isFixed ? (
        <Card className="border-amber-300 bg-amber-50/50 dark:border-amber-800/60 dark:bg-amber-950/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <RotateCcw className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <Label className="text-sm">실패한 수신자에게 재발송</Label>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              원본에서 실패한 수신자만 대상으로 새 메일 발송을 생성합니다. 그룹·개별 선택은 무시됩니다.
            </p>
            <Badge variant="secondary" className="text-xs mb-2">
              재발송 대상 {fixedRecipients?.length ?? 0}명
            </Badge>
            {(fixedRecipients?.length ?? 0) > 0 && (
              <div className="max-h-40 overflow-y-auto space-y-1 mt-2">
                {fixedRecipients!.slice(0, 10).map((c) => (
                  <div key={c.id || c.email} className="text-xs flex items-center gap-2">
                    <span className="text-muted-foreground truncate">{c.email}</span>
                    {c.name && <span className="text-muted-foreground">· {c.name}</span>}
                  </div>
                ))}
                {(fixedRecipients?.length ?? 0) > 10 && (
                  <div className="text-xs text-muted-foreground pt-1">
                    외 {(fixedRecipients?.length ?? 0) - 10}명
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          <Label>
            수신자 선택 <span className="text-destructive">*</span>
          </Label>
          <p className="text-xs text-muted-foreground">
            그룹 전체를 담거나, 검색 후 개별 연락처를 바구니에 담을 수 있습니다. 양쪽을 섞어도 이메일 중복은 자동으로 제거됩니다.
          </p>
          <RecipientBasket
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
      )}
    </div>
  )
}

type SignatureOpt = { id: string; name: string; html: string; is_default: boolean }

function Step2({
  templates,
  signatures,
  signatureId,
  setSignatureId,
  subject,
  setSubject,
  blocks,
  templateById,
  onAddBlock,
  onRemoveBlock,
  onMoveBlock,
  insertSubject,
  usedVariables,
  attachments,
  setAttachments,
  groups,
  ccEmails,
  setCcEmails,
  ccGroupIds,
  setCcGroupIds,
  ccContactIds,
  setCcContactIds,
  resolvedCcEmails,
  loadingCcBasket,
  bccEmails,
  setBccEmails,
  bccGroupIds,
  setBccGroupIds,
  bccContactIds,
  setBccContactIds,
  resolvedBccEmails,
  loadingBccBasket,
  recipientEmails,
  sendMode,
  setSendMode,
  recipientCount,
}: {
  templates: TemplateOpt[]
  signatures: SignatureOpt[]
  signatureId: string
  setSignatureId: (v: string) => void
  subject: string
  setSubject: (v: string) => void
  blocks: BlockItem[]
  templateById: Map<string, TemplateOpt>
  onAddBlock: (templateId: string) => void
  onRemoveBlock: (key: string) => void
  onMoveBlock: (key: string, dir: -1 | 1) => void
  insertSubject: (k: string) => void
  usedVariables: string[]
  attachments: DriveAttachmentRow[]
  setAttachments: Dispatch<SetStateAction<DriveAttachmentRow[]>>
  groups: GroupOpt[]
  ccEmails: string[]
  setCcEmails: (v: string[]) => void
  ccGroupIds: string[]
  setCcGroupIds: (v: string[]) => void
  ccContactIds: string[]
  setCcContactIds: (v: string[]) => void
  resolvedCcEmails: string[]
  loadingCcBasket: boolean
  bccEmails: string[]
  setBccEmails: (v: string[]) => void
  bccGroupIds: string[]
  setBccGroupIds: (v: string[]) => void
  bccContactIds: string[]
  setBccContactIds: (v: string[]) => void
  resolvedBccEmails: string[]
  loadingBccBasket: boolean
  recipientEmails: string[]
  sendMode: 'individual' | 'bulk'
  setSendMode: (v: 'individual' | 'bulk') => void
  recipientCount: number
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerFilter, setPickerFilter] = useState('')
  // 다이얼로그 내 체크 상태 — 선택 순서 유지를 위해 배열 사용
  const [pickerSelectedIds, setPickerSelectedIds] = useState<string[]>([])

  const filteredTemplates = useMemo(() => {
    const q = pickerFilter.trim().toLowerCase()
    if (!q) return templates
    return templates.filter(
      (t) => t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q)
    )
  }, [templates, pickerFilter])

  const openPicker = () => {
    setPickerFilter('')
    setPickerSelectedIds([])
    setPickerOpen(true)
  }

  const togglePickerSelect = (id: string) => {
    setPickerSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const confirmPickerSelection = () => {
    // 체크한 순서대로 블록 추가
    for (const id of pickerSelectedIds) onAddBlock(id)
    setPickerOpen(false)
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>서명 (선택)</Label>
        <Select
          value={signatureId || '__none__'}
          onValueChange={(v) => setSignatureId(v === '__none__' ? '' : v)}
        >
          <SelectTrigger>
            <SelectValue placeholder="서명 선택" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">사용 안함</SelectItem>
            {signatures.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name} {s.is_default && '(기본)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>
            메일 제목 <span className="text-destructive">*</span>
          </Label>
          <VariableDropdown onInsert={insertSubject} />
        </div>
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="안녕하세요 {{name}}님"
        />
        <p className="text-xs text-muted-foreground">
          광고성 정보라면 제목 앞에 (광고)를 붙여야 합니다 (정보통신망법 제50조).
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>참조 (Cc)</Label>
        <p className="text-xs text-muted-foreground">
          이메일을 직접 입력하거나, 그룹 / 개별 연락처를 담을 수 있습니다.
          {sendMode === 'individual'
            ? ' 개별 발송에서는 수신자마다 보내는 각 메일에 참조로 들어갑니다 — 참조 주소는 수신자 수만큼 메일을 받고, 모든 수신자가 참조 주소를 보게 됩니다.'
            : ' 한 번에 보내기에서는 1통의 메일에 참조로 포함됩니다.'}
        </p>
        <CcBccPicker
          kind="cc"
          emails={ccEmails}
          setEmails={setCcEmails}
          groups={groups}
          groupIds={ccGroupIds}
          setGroupIds={setCcGroupIds}
          contactIds={ccContactIds}
          setContactIds={setCcContactIds}
          resolvedEmails={resolvedCcEmails}
          loading={loadingCcBasket}
          recipientEmails={recipientEmails}
          sendMode={sendMode}
        />
      </div>

      <div className="space-y-1.5">
        <Label>숨은참조 (Bcc)</Label>
        <p className="text-xs text-muted-foreground">
          이메일을 직접 입력하거나, 그룹 / 개별 연락처를 담을 수 있습니다. 다른 수신자에겐 보이지 않습니다.
          {sendMode === 'individual' && ' 개별 발송에서는 수신자마다 보내는 각 메일에 포함되어, 숨은참조 주소는 수신자 수만큼 메일을 받습니다.'}
        </p>
        <CcBccPicker
          kind="bcc"
          emails={bccEmails}
          setEmails={setBccEmails}
          groups={groups}
          groupIds={bccGroupIds}
          setGroupIds={setBccGroupIds}
          contactIds={bccContactIds}
          setContactIds={setBccContactIds}
          resolvedEmails={resolvedBccEmails}
          loading={loadingBccBasket}
          recipientEmails={recipientEmails}
          sendMode={sendMode}
        />
      </div>

      <div className="space-y-1.5">
        <Label>발송 방식</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Card
            className={`cursor-pointer transition-colors ${sendMode === 'individual' ? 'border-primary bg-primary/5' : ''}`}
            onClick={() => setSendMode('individual')}
          >
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <Checkbox checked={sendMode === 'individual'} />
                <span className="text-sm font-medium">개별 발송</span>
                <Badge variant="secondary" className="text-[10px]">기본</Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                수신자별로 1통씩 발송 · 개인화 변수 ({`{{name}}`} 등) 사용 가능 · 발송 간격 적용
              </p>
            </CardContent>
          </Card>
          <Card
            className={`cursor-pointer transition-colors ${sendMode === 'bulk' ? 'border-primary bg-primary/5' : ''}`}
            onClick={() => setSendMode('bulk')}
          >
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <Checkbox checked={sendMode === 'bulk'} />
                <span className="text-sm font-medium">한 번에 보내기</span>
                <Badge
                  variant="secondary"
                  className={`text-[10px] ${recipientCount > 500 ? 'bg-destructive/10 text-destructive' : ''}`}
                >
                  {recipientCount}명 일괄
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                수신자 전원을 받는사람(To)에 넣어 1회 발송 · 서로의 이메일이 보임 · 개인화 변수 사용 불가 · 500명 이하 권장
              </p>
            </CardContent>
          </Card>
        </div>
        {sendMode === 'bulk' && usedVariables.length > 0 && (
          <p className="text-xs text-destructive bg-destructive/5 rounded p-2 mt-1">
            ⚠️ 본문/제목에 개인화 변수가 있어 한 번에 보내기로 발송할 수 없습니다:
            {' '}
            {usedVariables.map((v) => `{{${v}}}`).join(', ')}
          </p>
        )}
        {sendMode === 'bulk' && recipientCount > 500 && (
          <p className="text-xs text-destructive bg-destructive/5 rounded p-2 mt-1">
            ⚠️ 수신자 {recipientCount}명은 Gmail 일괄 발송 상한(500)을 초과합니다. 개별 발송 모드를 사용해주세요.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5">
            <Blocks className="w-3.5 h-3.5" />
            본문 블록 ({blocks.length}) <span className="text-destructive">*</span>
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={openPicker}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            블록 추가
          </Button>
        </div>

        {blocks.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              <Blocks className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>블록을 추가해 여러 템플릿을 순서대로 조합하세요.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {blocks.map((b, i) => {
              const t = templateById.get(b.templateId)
              return (
                <Card key={b.key}>
                  <CardContent className="p-3 flex items-center gap-2">
                    <div className="flex flex-col gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={i === 0}
                        onClick={() => onMoveBlock(b.key, -1)}
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={i === blocks.length - 1}
                        onClick={() => onMoveBlock(b.key, 1)}
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    <Badge variant="secondary" className="shrink-0">
                      {i + 1}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {t?.name ?? '(삭제된 템플릿)'}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {t?.subject ?? '-'}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => onRemoveBlock(b.key)}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <AttachmentSection
        attachments={attachments}
        onChange={setAttachments}
        showSizeGauge
      />

      {usedVariables.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-muted-foreground">사용된 변수:</span>
          {usedVariables.map((v) => (
            <Badge key={v} variant="secondary" className="text-[10px]">
              {`{{${v}}}`}
            </Badge>
          ))}
        </div>
      )}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>블록 추가 — 템플릿 선택</DialogTitle>
            <DialogDescription>
              여러 템플릿을 체크하면 체크한 순서대로 블록이 추가됩니다.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="템플릿 이름/제목 검색"
            value={pickerFilter}
            onChange={(e) => setPickerFilter(e.target.value)}
          />
          <div className="max-h-80 overflow-y-auto space-y-1">
            {filteredTemplates.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {templates.length === 0
                  ? '템플릿이 없습니다. 먼저 템플릿을 생성하세요.'
                  : '검색 결과가 없습니다.'}
              </div>
            ) : (
              filteredTemplates.map((t) => {
                const checked = pickerSelectedIds.includes(t.id)
                const order = pickerSelectedIds.indexOf(t.id) + 1
                return (
                  <label
                    key={t.id}
                    className={`w-full flex items-center gap-3 text-left p-2.5 rounded border cursor-pointer hover:bg-accent ${
                      checked ? 'border-primary bg-primary/5' : ''
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => togglePickerSelect(t.id)}
                    />
                    {checked && (
                      <Badge variant="secondary" className="shrink-0">
                        {order}
                      </Badge>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{t.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{t.subject}</div>
                    </div>
                  </label>
                )
              })
            )}
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-xs text-muted-foreground">
              {pickerSelectedIds.length > 0
                ? `${pickerSelectedIds.length}개 선택됨 (체크 순서대로 추가)`
                : '여러 개를 체크해 한 번에 추가할 수 있습니다'}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(false)}>
                취소
              </Button>
              <Button
                size="sm"
                disabled={pickerSelectedIds.length === 0}
                onClick={confirmPickerSelection}
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                {pickerSelectedIds.length > 0 ? `${pickerSelectedIds.length}개 추가` : '추가'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}


