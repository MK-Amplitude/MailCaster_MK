import { useState, useMemo, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SignaturePreview } from '@/components/signatures/SignaturePreview'
import TipTapEditor from '@/components/signatures/TipTapEditor'
import { AttachmentSection } from '@/components/attachments/AttachmentSection'
import { RecipientBasket } from '@/components/campaigns/RecipientBasket'
import { CcBccPicker } from '@/components/campaigns/CcBccPicker'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { useGroups } from '@/hooks/useGroups'
import { useTemplates } from '@/hooks/useTemplates'
import { useSignatures } from '@/hooks/useSignatures'
import { useCreateCampaign, useUpdateCampaign } from '@/hooks/useCampaigns'
import { renderTemplate, extractVariables } from '@/lib/mailMerge'
import { TEMPLATE_VARIABLES } from '@/types/template'
import { toast } from 'sonner'
import type { Database } from '@/types/database.types'

type DriveAttachmentRow = Database['mailcaster']['Tables']['drive_attachments']['Row']
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Users,
  FileText,
  Eye,
  Braces,
  Send,
  Loader2,
  Plus,
  ArrowUp,
  ArrowDown,
  X,
  Blocks,
  RotateCcw,
  Paperclip,
  Pencil,
  Undo2,
  Clock,
  CalendarClock,
} from 'lucide-react'
import { formatBytes, GMAIL_ATTACHMENT_SAFE_THRESHOLD } from '@/lib/utils'

type Step = 1 | 2 | 3

interface PreviewContact {
  id: string
  email: string
  name: string | null
  company: string | null
  department: string | null
  job_title: string | null
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
// 동일 이메일이 여러 그룹이나 contact 에서 유입돼도 한 번만 반환.
// 이메일 대소문자는 DB 원본을 보존(Map 의 value) 하고, 비교만 lowercase 로 수행.
async function resolveBasketEmails(
  groupIds: string[],
  contactIds: string[],
): Promise<string[]> {
  const emails = new Map<string, string>()
  if (groupIds.length > 0) {
    const { data, error } = await supabase
      .from('contact_groups')
      .select('contacts!inner(email, is_unsubscribed, is_bounced)')
      .in('group_id', groupIds)
      // PostgREST 기본 1000행 cap 우회 — 대형 그룹 cc/bcc 시 수신자 누락 방지
      .range(0, 9999)
    if (error) {
      console.error('[wizard] resolve cc/bcc groups failed:', error)
      throw error
    }
    type JoinRow = {
      contacts: {
        email: string | null
        is_unsubscribed: boolean
        is_bounced: boolean
      } | null
    }
    for (const row of (data as unknown as JoinRow[]) ?? []) {
      const c = row.contacts
      if (!c || c.is_unsubscribed || c.is_bounced || !c.email) continue
      const em = c.email.trim()
      if (!em) continue
      emails.set(em.toLowerCase(), em)
    }
  }
  if (contactIds.length > 0) {
    const { data, error } = await supabase
      .from('contacts')
      .select('email, is_unsubscribed, is_bounced')
      .in('id', contactIds)
      // PostgREST 기본 1000행 cap 우회 — 대량 cc/bcc 선택 시 일부 누락 방지
      .range(0, 9999)
    if (error) {
      console.error('[wizard] resolve cc/bcc contacts failed:', error)
      throw error
    }
    for (const c of (data ?? []) as Array<{
      email: string | null
      is_unsubscribed: boolean
      is_bounced: boolean
    }>) {
      if (!c || c.is_unsubscribed || c.is_bounced || !c.email) continue
      const em = c.email.trim()
      if (!em) continue
      emails.set(em.toLowerCase(), em)
    }
  }
  return [...emails.values()]
}

function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of emails) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

// "테이블 없음" 에러 감지 — migration 미적용 시나리오를 자연스럽게 처리하기 위함.
// 예: migration 009 (campaign_contacts) 미적용 시 load 경로의 campaign_contacts 쿼리가 실패.
//     이때 편집 화면 자체를 막기보다, 해당 섹션만 skip 하고 사용자가 수정/저장을 계속할 수 있게 한다.
//
// 다루는 코드:
//   - 42P01  : PostgreSQL undefined_table (직접 DB 에러가 올라오는 경우)
//   - PGRST205: PostgREST schema cache miss ("Could not find the table ... in the schema cache")
//     ↳ migration 직후 PostgREST 가 캐시 리로드 전이거나, 권한/스키마 노출 설정이 안 된 경우.
//       메시지 패턴으로도 방어(hint 만 있고 code 가 다른 경우를 대비).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isMissingTableError(err: any): boolean {
  const msg: string = err?.message ?? ''
  return (
    err?.code === '42P01' ||
    err?.code === 'PGRST205' ||
    /relation .* does not exist/i.test(msg) ||
    /could not find the table/i.test(msg)
  )
}

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

  const [searchParams, setSearchParams] = useSearchParams()
  const reuseFrom = searchParams.get('from')
  const reuseMode = searchParams.get('mode') as ReuseMode | null
  const editCampaignId = searchParams.get('edit')
  const isEditMode = !!editCampaignId

  const [step, setStep] = useState<Step>(1)
  const [submitting, setSubmitting] = useState(false)

  const [name, setName] = useState('')
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  // Phase 5: 개별 연락처 바구니 — 그룹과 병존, 최종 수신자는 양쪽을 union+dedupe
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([])
  // Phase 6 (B): 캠페인 단위 제외 명단 — campaign_exclusions 에 저장.
  // 그룹 union 안의 contact 를 최종 수신자에서 빼고 싶을 때 사용.
  const [excludedContactIds, setExcludedContactIds] = useState<string[]>([])

  const [blocks, setBlocks] = useState<BlockItem[]>([])
  const [signatureId, setSignatureId] = useState<string>('')
  const [subject, setSubject] = useState('')

  // 사용자가 Step 3 미리보기에서 합쳐진 본문을 직접 편집하면 그 HTML 을 보관.
  // null 이면 composedHtml(블록+서명) 을 그대로 사용.
  // 블록을 바꾸면 바로 반영돼야 할지(= null 유지) 그대로 둘지(= override 유지) 는 UX 결정.
  // 여기선 "override 우선" — 사용자가 직접 편집한 건 본인이 명시적으로 '블록으로 되돌리기' 하기 전엔 안 사라진다.
  const [bodyOverride, setBodyOverride] = useState<string | null>(null)

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

  // 발송 모드: 'individual' = 수신자별 개별 발송 (기본), 'bulk' = 1회 브로드캐스트 (BCC 전원)
  const [sendMode, setSendMode] = useState<'individual' | 'bulk'>('individual')

  // 예약 발송:
  //   scheduledAt = null  → 즉시 발송 (기본, status='draft' 로 저장 후 사용자가 수동으로 '발송하기' 클릭)
  //   scheduledAt = ISO   → 예약 발송 (status='scheduled' 로 저장, pg_cron 이 해당 시각에 자동 발송)
  //
  // 주의: HTML <input type="datetime-local"> 는 "YYYY-MM-DDTHH:mm" 로컬 시간 문자열을 쓴다.
  //       여기선 내부적으로 ISO UTC 로 정규화해 저장 시 DB 로 보낸다.
  const [scheduledAt, setScheduledAt] = useState<string | null>(null)

  // 첨부 파일 — 블록 추가 시 해당 템플릿의 첨부가 자동 포함 + 수동 추가 가능
  const [attachments, setAttachments] = useState<DriveAttachmentRow[]>([])

  // 재사용 모드: 원본의 실패 수신자를 그대로 쓰는 경우.
  // null 이면 그룹 기반 preview 사용 (신규/전체복제 동일 플로우).
  const [fixedRecipients, setFixedRecipients] = useState<PreviewContact[] | null>(null)
  const [reuseLoading, setReuseLoading] = useState(!!reuseFrom || !!editCampaignId)
  const [reuseSourceName, setReuseSourceName] = useState<string>('')

  const { data: groups = [] } = useGroups()
  const { data: templates = [] } = useTemplates()
  const { data: signatures = [] } = useSignatures()
  const createCampaign = useCreateCampaign()
  const updateCampaign = useUpdateCampaign()

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
  const [rawUnion, setRawUnion] = useState<PreviewContact[]>([])
  const [loadingPreview, setLoadingPreview] = useState(false)
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
          .select('name, subject, signature_id, send_delay_seconds, cc, bcc, send_mode, body_html, scheduled_at, status')
          .eq('id', loadFrom)
          .single()
        if (cancelled) return
        if (cErr) throw cErr
        c = data as Record<string, unknown> | null
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
          setDelaySeconds((c.send_delay_seconds as number | null) ?? 3)
          setSendMode((c.send_mode as 'individual' | 'bulk' | null) === 'bulk' ? 'bulk' : 'individual')

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
          if (storedBody && storedBody.trim()) setBodyOverride(storedBody)
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
        const { data: ccs, error: ccsErr } = await supabase
          .from('campaign_contacts')
          .select('contact_id')
          .eq('campaign_id', loadFrom)
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
        const { data: exs, error: exsErr } = await supabase
          .from('campaign_exclusions')
          .select('contact_id')
          .eq('campaign_id', loadFrom)
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
        if (isEditMode && !hasBasket) {
          const { data: rs, error: rErr } = await supabase
            .from('recipients')
            .select('contact_id, email, name, variables')
            .eq('campaign_id', loadFrom)
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
            }
          })
          setFixedRecipients(fixed)
        } else if (!isEditMode && reuseMode === 'failed') {
          const { data: rs, error: rErr } = await supabase
            .from('recipients')
            .select('contact_id, email, name, variables')
            .eq('campaign_id', loadFrom)
            .eq('status', 'failed')
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
  //   - fixedRecipients 모드: 그대로 통과 (실패 재발송 / 편집모드 recipient-only)
  //   - 일반 모드: 그룹에서 풀어낸 연락처 ∪ 개별 선택 연락처
  //     → id 기준 dedupe + 이메일 기준 dedupe 둘 다 적용
  //     → 수신거부/반송 은 양쪽 모두에서 제외
  useEffect(() => {
    if (fixedRecipients !== null) {
      setRawUnion(fixedRecipients)
      return
    }
    if (selectedGroupIds.length === 0 && selectedContactIds.length === 0) {
      setRawUnion([])
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
        is_unsubscribed: boolean
        is_bounced: boolean
      }

      // 1) 그룹 → 연락처 (inner join)
      const groupContacts: ContactRow[] = []
      if (selectedGroupIds.length > 0) {
        const { data, error } = await supabase
          .from('contact_groups')
          .select(
            'contacts!inner(id, email, name, company, department, job_title, is_unsubscribed, is_bounced)'
          )
          .in('group_id', selectedGroupIds)
          // PostgREST 기본 1000행 cap 우회 — 대형 그룹 선택 시 수신자 누락 방지
          .range(0, 9999)

        if (cancelled) return
        if (error) {
          console.error('[wizard] preview group fetch failed:', error)
          toast.error('그룹 수신자 조회 실패')
          setLoadingPreview(false)
          return
        }
        type JoinRow = { contacts: ContactRow }
        const rows = (data as unknown as JoinRow[]) ?? []
        for (const r of rows) if (r.contacts) groupContacts.push(r.contacts)
      }

      // 2) 개별 연락처 직접 조회
      const individualContacts: ContactRow[] = []
      if (selectedContactIds.length > 0) {
        const { data, error } = await supabase
          .from('contacts')
          .select('id, email, name, company, department, job_title, is_unsubscribed, is_bounced')
          .in('id', selectedContactIds)
          // PostgREST 기본 1000행 cap 우회 — 미리보기/발송 단계에서 수신자 누락 방지
          .range(0, 9999)

        if (cancelled) return
        if (error) {
          console.error('[wizard] preview contact fetch failed:', error)
          toast.error('개별 연락처 조회 실패')
          setLoadingPreview(false)
          return
        }
        for (const c of (data ?? []) as ContactRow[]) individualContacts.push(c)
      }

      // 3) dedupe by id + email, exclude 수신거부/반송
      const byId = new Map<string, PreviewContact>()
      const seenEmails = new Set<string>()
      for (const c of [...groupContacts, ...individualContacts]) {
        if (!c || c.is_unsubscribed || c.is_bounced) continue
        if (byId.has(c.id)) continue
        const em = (c.email ?? '').trim().toLowerCase()
        if (!em) continue
        if (seenEmails.has(em)) continue
        seenEmails.add(em)
        byId.set(c.id, {
          id: c.id,
          email: c.email,
          name: c.name,
          company: c.company,
          department: c.department,
          job_title: c.job_title,
        })
      }

      if (cancelled) return
      setLoadingPreview(false)
      setRawUnion(Array.from(byId.values()))
    })()
    return () => {
      cancelled = true
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
  useEffect(() => {
    if (ccGroupIds.length === 0 && ccContactIds.length === 0) {
      setCcBasketEmails([])
      return
    }
    let cancelled = false
    setLoadingCcBasket(true)
    ;(async () => {
      const emails = await resolveBasketEmails(ccGroupIds, ccContactIds)
      if (cancelled) return
      setCcBasketEmails(emails)
      setLoadingCcBasket(false)
    })()
    return () => {
      cancelled = true
    }
  }, [ccGroupIds, ccContactIds])

  useEffect(() => {
    if (bccGroupIds.length === 0 && bccContactIds.length === 0) {
      setBccBasketEmails([])
      return
    }
    let cancelled = false
    setLoadingBccBasket(true)
    ;(async () => {
      const emails = await resolveBasketEmails(bccGroupIds, bccContactIds)
      if (cancelled) return
      setBccBasketEmails(emails)
      setLoadingBccBasket(false)
    })()
    return () => {
      cancelled = true
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
    if (composedHtml === bodyOverride) setBodyOverride(null)
  }, [composedHtml, bodyOverride])

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
    if (!first) return null
    const vars: Record<string, string> = {
      name: first.name ?? '',
      email: first.email,
      company: first.company ?? '',
      department: first.department ?? '',
      job_title: first.job_title ?? '',
    }
    return {
      subject: renderTemplate(subject, vars),
      html: renderTemplate(effectiveBody, vars),
      contact: first,
    }
  }, [subject, effectiveBody, previewContacts])

  // 검증
  // Phase 5: 개별 연락처만 담아도 진행 가능하도록 — 그룹 / 연락처 중 하나라도 있으면 OK
  const canNextFromStep1 =
    !!name.trim() &&
    previewContacts.length > 0 &&
    (fixedRecipients !== null || selectedGroupIds.length > 0 || selectedContactIds.length > 0)
  const canNextFromStep2 = subject.trim() && blocks.length > 0

  const insertVariableIntoSubject = (key: string) => setSubject((s) => s + `{{${key}}}`)

  const addBlock = (templateId: string) => {
    const t = templateById.get(templateId)
    if (!t) return
    // prev.length 로 판정해야 multi-select 시에도 "첫 번째" 템플릿의 subject 만 채워짐
    // (stale closure 의 blocks.length 는 루프 내 모든 호출에서 0 이라 마지막 템플릿 것으로 덮임)
    setBlocks((prev) => {
      if (prev.length === 0) {
        setSubject((s) => (s.trim() ? s : t.subject))
      }
      return [...prev, { key: crypto.randomUUID(), templateId }]
    })
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
    // Step 3 에서 제목을 인라인으로 수정할 수 있게 된 뒤로는
    // Step 2 의 canNextFromStep2 가드를 우회해 빈 제목으로 도달할 수 있음.
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
    setSubmitting(true)
    // 저장 경로에서 "테이블 없음"(42P01/PGRST205) 으로 skip 한 보조 테이블을 모아뒀다가
    // 완료 직전에 한 번에 경고 토스트로 알려준다. (save 마다 여러 개가 나오면 시끄러우므로)
    // campaigns / campaign_blocks / campaign_attachments / recipients 는 core 로 간주해
    // 실제 실패 시 바로 throw — 이쪽이 없으면 시스템이 작동 불가능한 수준이라 조용한 skip 은 위험.
    const missingAuxTables: string[] = []
    try {
      if (isEditMode && editCampaignId) {
        // ===== 편집 모드: 기존 draft/scheduled 캠페인 덮어쓰기 =====
        // status / scheduled_at 도 이 경로에서 갱신한다 (예약 시각을 편집 중 변경할 수 있게).
        // child rows 는 delete→insert 로 교체 (Supabase JS 클라이언트는 트랜잭션 미지원).
        await updateCampaign.mutateAsync({
          id: editCampaignId,
          data: {
            name: name.trim(),
            signature_id: signatureId || null,
            subject: subject.trim(),
            body_html: effectiveBody,
            total_count: previewContacts.length,
            send_delay_seconds: delaySeconds,
            // Phase 7: cc / bcc 는 "직접 입력 + 그룹 멤버 + 개별 연락처" 의
            // union+dedupe 결과를 저장 (발송 시 Gmail 이 그대로 사용).
            cc: resolvedCcEmails,
            bcc: resolvedBccEmails,
            send_mode: sendMode,
            // 예약 시각 변경:
            //   scheduledAt 설정 → status='scheduled' + scheduled_at
            //   scheduledAt null → status='draft'     + scheduled_at=null (예약 해제)
            status: scheduledAt ? 'scheduled' : 'draft',
            scheduled_at: scheduledAt,
          },
        })

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
        // rawUnion 에 현재 존재하는 exclusions 만 저장 — 그룹이 바뀌어
        // 더 이상 union 에 없는 고아(orphan) 제외는 자동 정리.
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
            const unionIds = new Set(rawUnion.map((c) => c.id))
            const validExclusions = excludedContactIds.filter(
              (id) => id && unionIds.has(id)
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

        // 4) recipients 교체 — draft/scheduled 캠페인은 모두 pending 이라 데이터 손실 없음
        {
          const { error: delErr } = await supabase
            .from('recipients')
            .delete()
            .eq('campaign_id', editCampaignId)
          if (delErr) throw delErr
          const BATCH = 500
          for (let i = 0; i < previewContacts.length; i += BATCH) {
            const chunk = previewContacts.slice(i, i + BATCH)
            const rows = chunk.map((c) => ({
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
              },
              status: 'pending' as const,
            }))
            const { error: insErr } = await supabase.from('recipients').insert(rows)
            if (insErr) throw insErr
          }
        }

        // useUpdateCampaign 은 ['campaigns'] prefix 만 무효화하므로
        // 다른 key space 를 쓰는 child 쿼리들은 여기서 명시적으로 무효화해야
        // Detail 페이지로 돌아갔을 때 옛 블록/첨부가 잠깐이라도 보이지 않는다.
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
        //    scheduledAt 이 있으면 status='scheduled' + scheduled_at 으로 저장 → pg_cron 이 자동 발송
        const campaign = await createCampaign.mutateAsync({
          name: name.trim(),
          template_id: null,
          signature_id: signatureId || null,
          subject: subject.trim(),
          body_html: effectiveBody,
          status: scheduledAt ? 'scheduled' : 'draft',
          scheduled_at: scheduledAt,
          total_count: previewContacts.length,
          send_delay_seconds: delaySeconds,
          // Phase 7: 최종 union+dedupe 이메일 배열 — 발송 경로(useSendCampaign)가 이 값 사용
          cc: resolvedCcEmails,
          bcc: resolvedBccEmails,
          send_mode: sendMode,
        })

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

        // 3-c) Phase 6 (B): 제외 명단 저장 — rawUnion 에 속한 것만 저장 (orphan 정리)
        if (fixedRecipients === null && excludedContactIds.length > 0) {
          const unionIds = new Set(rawUnion.map((c) => c.id))
          const validExclusions = excludedContactIds.filter(
            (id) => id && unionIds.has(id)
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
              job_title: c.job_title ?? '',
            },
            status: 'pending' as const,
          }))
          const { error: rErr } = await supabase.from('recipients').insert(rows)
          if (rErr) throw rErr
        }

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
      const userMsg =
        anyErr?.hint ||
        anyErr?.details ||
        anyErr?.message ||
        (isEditMode ? '메일 발송 저장 실패' : '메일 발송 생성 실패')
      toast.error(userMsg)
    } finally {
      setSubmitting(false)
    }
  }

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
        <StepIndicator step={step} />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
          {reuseLoading && (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {!reuseLoading && step === 1 && (
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
          )}

          {!reuseLoading && step === 2 && (
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
              composedHtml={effectiveBody}
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
              recipientEmails={previewContacts.map((c) => c.email)}
              sendMode={sendMode}
              setSendMode={setSendMode}
              recipientCount={previewContacts.length}
              bodyOverridden={bodyOverride !== null}
              onResetBody={() => setBodyOverride(null)}
            />
          )}

          {!reuseLoading && step === 3 && (
            <Step3
              name={name}
              totalCount={previewContacts.length}
              preview={previewRendered}
              delaySeconds={delaySeconds}
              setDelaySeconds={setDelaySeconds}
              usedVariables={usedVariables}
              blockCount={blocks.length}
              attachments={attachments}
              subject={subject}
              setSubject={setSubject}
              effectiveBody={effectiveBody}
              bodyOverridden={bodyOverride !== null}
              onBodyChange={(html) => setBodyOverride(html)}
              onResetBody={() => setBodyOverride(null)}
              insertSubject={insertVariableIntoSubject}
              cc={resolvedCcEmails}
              bcc={resolvedBccEmails}
              sendMode={sendMode}
              scheduledAt={scheduledAt}
              setScheduledAt={setScheduledAt}
            />
          )}
        </div>
      </div>

      <div className="px-4 sm:px-6 py-3 border-t flex items-center justify-between bg-card">
        <Button
          variant="outline"
          onClick={() => {
            if (step === 1) navigate('/campaigns')
            else setStep((s) => (s - 1) as Step)
          }}
          disabled={submitting}
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          {step === 1 ? '취소' : '이전'}
        </Button>

        {step < 3 ? (
          <Button
            onClick={() => setStep((s) => (s + 1) as Step)}
            disabled={
              reuseLoading ||
              (step === 1 && !canNextFromStep1) ||
              (step === 2 && !canNextFromStep2)
            }
          >
            다음
            <ArrowRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={
              submitting ||
              reuseLoading ||
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
        )}
      </div>
    </div>
  )
}

function StepIndicator({ step }: { step: Step }) {
  const steps = [
    { n: 1, label: '수신자', icon: Users },
    { n: 2, label: '내용', icon: FileText },
    { n: 3, label: '미리보기', icon: Eye },
  ]
  return (
    <div className="flex items-center gap-2 mt-3">
      {steps.map((s, i) => {
        const Icon = s.icon
        const active = step === s.n
        const done = step > s.n
        return (
          <div key={s.n} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : done
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {s.label}
            </div>
            {i < steps.length - 1 && <div className="w-6 h-px bg-border" />}
          </div>
        )
      })}
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
  composedHtml,
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
  bodyOverridden,
  onResetBody,
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
  composedHtml: string
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
  /** 사용자가 Step 3 에서 본문을 직접 편집한 상태 */
  bodyOverridden: boolean
  /** 편집을 버리고 블록 조합 결과로 되돌림 */
  onResetBody: () => void
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
      </div>

      <div className="space-y-1.5">
        <Label>참조 (Cc)</Label>
        <p className="text-xs text-muted-foreground">
          이메일을 직접 입력하거나, 그룹 / 개별 연락처를 담을 수 있습니다. 모든 수신자에게 동일하게 참조로 포함됩니다.
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
        />
      </div>

      <div className="space-y-1.5">
        <Label>숨은참조 (Bcc)</Label>
        <p className="text-xs text-muted-foreground">
          이메일을 직접 입력하거나, 그룹 / 개별 연락처를 담을 수 있습니다. 다른 수신자에겐 보이지 않습니다.
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

      {blocks.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>합쳐진 본문 미리보기</Label>
            {bodyOverridden && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">
                  직접 편집됨
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={onResetBody}
                >
                  <Undo2 className="w-3.5 h-3.5 mr-1" />
                  블록으로 되돌리기
                </Button>
              </div>
            )}
          </div>
          {bodyOverridden && (
            <p className="text-xs text-muted-foreground">
              미리보기에 사용자가 직접 수정한 본문이 보입니다. 블록 순서를 바꾸거나 서명을 변경해도
              여기엔 반영되지 않으며, 되돌리려면 위 버튼을 눌러주세요.
            </p>
          )}
          <Card>
            <CardContent className="p-0">
              <div className="bg-white dark:bg-gray-950">
                <SignaturePreview html={composedHtml} />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

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

function Step3({
  name,
  totalCount,
  preview,
  delaySeconds,
  setDelaySeconds,
  usedVariables,
  blockCount,
  attachments,
  subject,
  setSubject,
  effectiveBody,
  bodyOverridden,
  onBodyChange,
  onResetBody,
  insertSubject,
  cc,
  bcc,
  sendMode,
  scheduledAt,
  setScheduledAt,
}: {
  name: string
  totalCount: number
  preview: { subject: string; html: string; contact: PreviewContact } | null
  delaySeconds: number
  setDelaySeconds: (v: number) => void
  usedVariables: string[]
  blockCount: number
  attachments: DriveAttachmentRow[]
  subject: string
  setSubject: (v: string) => void
  /** 편집 대상 본문 (override 가 있으면 override, 없으면 composedHtml). 개인화 변수가 렌더링 전 상태로 들어있음. */
  effectiveBody: string
  /** 사용자가 이미 직접 편집한 상태인지 */
  bodyOverridden: boolean
  /** 에디터 변경 시 override 저장 */
  onBodyChange: (html: string) => void
  /** 편집을 버리고 블록 조합 결과로 되돌림 */
  onResetBody: () => void
  insertSubject: (k: string) => void
  cc: string[]
  bcc: string[]
  sendMode: 'individual' | 'bulk'
  /** 예약 발송 시각 — null 이면 즉시 발송 */
  scheduledAt: string | null
  setScheduledAt: (v: string | null) => void
}) {
  const totalAttachmentSize = attachments.reduce((sum, a) => sum + (a.file_size ?? 0), 0)
  // useSendCampaign 의 실제 fallback 기준(SAFE_THRESHOLD)과 일치시킴
  const willFallback = totalAttachmentSize > GMAIL_ATTACHMENT_SAFE_THRESHOLD
  const bulkBlocked = sendMode === 'bulk' && usedVariables.length > 0
  // 본문 편집 토글 — '본문 수정' 버튼으로 켜고, '완료' 로 끈다.
  const [editingBody, setEditingBody] = useState(false)
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="text-xs text-muted-foreground">메일 발송</div>
              <div className="font-semibold">{name}</div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={sendMode === 'bulk' ? 'default' : 'secondary'}>
                <Send className="w-3 h-3 mr-1" />
                {sendMode === 'bulk' ? '한 번에 보내기' : '개별 발송'}
              </Badge>
              <Badge variant="secondary">
                <Blocks className="w-3 h-3 mr-1" />
                블록 {blockCount}개
              </Badge>
              <Badge variant="secondary">
                <Users className="w-3 h-3 mr-1" />
                {totalCount}명
              </Badge>
              {scheduledAt && (
                <Badge variant="default" className="bg-blue-600 hover:bg-blue-600">
                  <CalendarClock className="w-3 h-3 mr-1" />
                  예약 {new Date(scheduledAt).toLocaleString('ko-KR', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Badge>
              )}
              {attachments.length > 0 && (
                <Badge variant={willFallback ? 'default' : 'secondary'}>
                  <Paperclip className="w-3 h-3 mr-1" />
                  첨부 {attachments.length}개 · {formatBytes(totalAttachmentSize)}
                  {willFallback && ' → 링크'}
                </Badge>
              )}
            </div>
          </div>
          {(cc.length > 0 || bcc.length > 0) && (
            <div className="text-xs space-y-1 pt-1 border-t">
              {cc.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0">Cc:</span>
                  <span className="flex-1 break-all">{cc.join(', ')}</span>
                </div>
              )}
              {bcc.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0">Bcc:</span>
                  <span className="flex-1 break-all">{bcc.join(', ')}</span>
                </div>
              )}
            </div>
          )}
          {attachments.length > 0 && willFallback && (
            <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50/60 dark:bg-amber-950/20 rounded p-2 mt-1">
              Gmail 25MB 초과 — 수신자에게는 Drive 공유 링크가 본문 하단에 자동 추가됩니다.
            </div>
          )}
          {sendMode === 'bulk' && (
            <div className={`text-xs rounded p-2 mt-1 ${bulkBlocked ? 'bg-destructive/10 text-destructive' : 'bg-blue-50/60 dark:bg-blue-950/20 text-blue-700 dark:text-blue-300'}`}>
              {bulkBlocked
                ? `⚠️ 본문/제목에 개인화 변수(${usedVariables.map((v) => `{{${v}}}`).join(', ')})가 있어 한 번에 보내기로는 발송할 수 없습니다.`
                : `수신자 ${totalCount}명 전원이 받는사람(To)에 공개되어 1회 발송됩니다. 서로의 이메일 주소가 보입니다.`}
            </div>
          )}
        </CardContent>
      </Card>

      {sendMode === 'individual' && (
        <div className="space-y-1.5">
          <Label>발송 간격 (초)</Label>
          <Input
            type="number"
            min={0}
            max={60}
            value={delaySeconds}
            onChange={(e) => setDelaySeconds(Math.max(0, Number(e.target.value) || 0))}
            className="max-w-[120px]"
          />
          <p className="text-xs text-muted-foreground">
            Gmail 일일 한도 초과를 방지하기 위해 메일 간 지연 시간을 설정합니다.
          </p>
        </div>
      )}

      <ScheduleSection
        scheduledAt={scheduledAt}
        setScheduledAt={setScheduledAt}
        hasAttachments={attachments.length > 0}
      />

      <div className="space-y-1.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label>미리보기 ({preview?.contact.email})</Label>
          <div className="flex items-center gap-2">
            {bodyOverridden && (
              <Badge variant="secondary" className="text-[10px]">
                본문 직접 편집됨
              </Badge>
            )}
            {usedVariables.length > 0 && (
              <span className="text-xs text-muted-foreground">
                변수 {usedVariables.length}개 사용 중
              </span>
            )}
          </div>
        </div>
        {preview ? (
          <Card>
            <CardContent className="p-0">
              <div className="px-4 py-3 border-b bg-muted/30 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">제목</div>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    <VariableDropdown onInsert={insertSubject} />
                    {bodyOverridden && !editingBody && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={onResetBody}
                        title="블록 조합으로 되돌림 — 사용자가 직접 편집한 내용은 사라집니다"
                      >
                        <Undo2 className="w-3.5 h-3.5 mr-1" />
                        블록으로 되돌리기
                      </Button>
                    )}
                    {editingBody ? (
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 text-xs"
                        onClick={() => setEditingBody(false)}
                      >
                        <Check className="w-3.5 h-3.5 mr-1" />
                        편집 완료
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setEditingBody(true)}
                      >
                        <Pencil className="w-3.5 h-3.5 mr-1" />
                        본문 수정
                      </Button>
                    )}
                  </div>
                </div>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="h-8 text-sm"
                  placeholder="메일 제목"
                />
                {preview.subject && preview.subject !== subject && (
                  <div className="text-xs text-muted-foreground truncate">
                    렌더링: {preview.subject}
                  </div>
                )}
              </div>
              {editingBody ? (
                <div className="p-3 space-y-2 bg-muted/10">
                  <p className="text-xs text-muted-foreground">
                    합쳐진 본문을 직접 편집합니다. {`{{name}}`} 같은 개인화 변수는 그대로 유지되며,
                    발송 시 각 수신자에 맞춰 치환됩니다. 편집을 완료하면 렌더링된 미리보기로 돌아갑니다.
                  </p>
                  <TipTapEditor
                    value={effectiveBody}
                    onChange={onBodyChange}
                    placeholder="본문을 입력하세요"
                  />
                </div>
              ) : (
                <div className="bg-white dark:bg-gray-950">
                  <SignaturePreview html={preview.html} />
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">미리보기할 수신자가 없습니다.</p>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// 발송 예약 섹션 — 즉시 / 예약 토글 + datetime-local 입력
// ------------------------------------------------------------
// scheduledAt 값은 DB 저장용 ISO(UTC) 문자열로 유지한다. <input type="datetime-local">
// 은 "YYYY-MM-DDTHH:mm" 로컬 시간 문자열만 주고받으므로, toLocalInputValue /
// fromLocalInputValue 로 변환한다.
function toLocalInputValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  // 로컬 오프셋 보정 — datetime-local 은 UTC 를 이해 못하고 "내 PC 시간대의 시각" 으로 해석함.
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInputValue(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

function ScheduleSection({
  scheduledAt,
  setScheduledAt,
  hasAttachments,
}: {
  scheduledAt: string | null
  setScheduledAt: (v: string | null) => void
  hasAttachments: boolean
}) {
  const isScheduled = scheduledAt !== null
  // 최소값은 현재로부터 2분 뒤 (서버 cron 이 1분 주기라 여유 필요)
  const minLocal = useMemo(() => {
    const d = new Date(Date.now() + 2 * 60_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }, [])

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <CalendarClock className="w-3.5 h-3.5" />
        발송 시점
      </Label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Card
          className={`cursor-pointer transition-colors ${!isScheduled ? 'border-primary bg-primary/5' : ''}`}
          onClick={() => setScheduledAt(null)}
        >
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Checkbox checked={!isScheduled} />
              <span className="text-sm font-medium">즉시 발송</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              초안으로 저장한 뒤 "발송하기" 버튼을 눌러 지금 바로 발송합니다.
            </p>
          </CardContent>
        </Card>
        <Card
          className={`cursor-pointer transition-colors ${isScheduled ? 'border-primary bg-primary/5' : ''}`}
          onClick={() => {
            if (!isScheduled) {
              // 기본값: 현재 + 10분 (반올림 없이 분 단위)
              const d = new Date(Date.now() + 10 * 60_000)
              d.setSeconds(0, 0)
              setScheduledAt(d.toISOString())
            }
          }}
        >
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Checkbox checked={isScheduled} />
              <span className="text-sm font-medium">예약 발송</span>
              <Badge variant="secondary" className="text-[10px]">
                <Clock className="w-3 h-3 mr-0.5" />
                자동
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              지정한 시각에 서버가 자동으로 발송합니다. 창을 닫아도 동작합니다.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Phase 5: 첨부 + 예약 지원됨 — 안내 배너 */}
      {isScheduled && hasAttachments && (
        <p className="text-xs text-blue-700 dark:text-blue-300 bg-blue-50/60 dark:bg-blue-950/20 rounded p-2">
          📎 첨부 파일은 예약된 시각에 Google Drive 에서 자동으로 처리됩니다. 총 15MB 를 초과하는
          첨부는 Drive 공유 링크로 전환되어 본문에 포함됩니다.
        </p>
      )}

      {isScheduled && (
        <div className="space-y-1.5 pt-1">
          <Label className="text-xs">발송 예정 일시 (내 PC 시간 기준)</Label>
          <Input
            type="datetime-local"
            value={toLocalInputValue(scheduledAt)}
            min={minLocal}
            onChange={(e) => setScheduledAt(fromLocalInputValue(e.target.value))}
            className="max-w-[260px]"
          />
          {scheduledAt && (
            <p className="text-xs text-muted-foreground">
              {new Date(scheduledAt).toLocaleString('ko-KR', {
                weekday: 'short',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              (약 {formatRelativeFuture(scheduledAt)} 뒤)
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function formatRelativeFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return '지금'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}분`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}시간`
  const day = Math.round(hr / 24)
  return `${day}일`
}

function VariableDropdown({ onInsert }: { onInsert: (key: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs">
          <Braces className="w-3.5 h-3.5 mr-1" />
          변수 삽입
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {TEMPLATE_VARIABLES.map((v) => (
          <DropdownMenuItem key={v.key} onClick={() => onInsert(v.key)} className="text-xs">
            <span className="font-medium">{`{{${v.key}}}`}</span>
            <span className="ml-auto text-muted-foreground">{v.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
