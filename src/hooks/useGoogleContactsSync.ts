// Google Contacts (리멤버 주소록 포함) 동기화 hook.
//
// 사용자가 리멤버 앱에서 "구글 주소록 자동 저장" 을 켰다는 가정 하에,
// MailCaster 가 Google People API 로 incremental sync 해서 contacts 에 추가.
// 기존 import 정책과 동일하게 email 기준 보존 (덮어쓰지 않음).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { useAuth } from './useAuth'

interface SyncResult {
  inserted: number
  duplicates: number
  deleted_skipped: number
  total_fetched?: number
  in_other_org?: number
  scope_missing?: boolean
  api_disabled?: boolean
  detail?: string
  message?: string
  sync_token_updated?: boolean
  errors?: Array<{ message: string }>
}

// 마지막 sync 시각 + 자동 sync 토글 — Settings UI 표시용.
export function useGoogleContactsSyncStatus() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['google-contacts-sync-status', user?.id],
    queryFn: async () => {
      if (!user) return null
      const { data, error } = await supabase
        .from('profiles')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .select('google_contacts_last_sync_at, google_contacts_auto_sync' as any)
        .eq('id', user.id)
        .single()
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      return {
        last_sync_at: p?.google_contacts_last_sync_at as string | null,
        auto_sync: !!p?.google_contacts_auto_sync,
      }
    },
    enabled: !!user,
  })
}

export function useSyncGoogleContacts() {
  const qc = useQueryClient()
  const { currentOrg } = useAuth()
  return useMutation({
    mutationFn: async (opts: { forceFull?: boolean } = {}): Promise<SyncResult> => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      // 현재 선택된 조직에 연락처가 들어가도록 org_id 필수 —
      // 미로딩 상태에서 서버의 "첫 멤버십" 폴백으로 조용히 넘어가면
      // 멀티 조직 사용자에서 다른 조직에 들어가는 버그가 재발한다.
      if (!currentOrg?.id) {
        throw new Error('조직 정보를 불러오는 중입니다. 잠시 후 다시 시도해주세요.')
      }

      // syncToken 만료 시 full sync 전환은 서버 (sync-google-contacts) 가 처리.
      const { data, error } = await supabase.functions.invoke('sync-google-contacts', {
        body: { force_full: opts.forceFull ?? false, org_id: currentOrg.id },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) {
        let friendly = '동기화에 실패했습니다.'
        try {
          const resp = (error as { context?: Response }).context
          if (resp) {
            const body = (await resp.json()) as { error?: string; detail?: string }
            friendly = body.error || body.detail || friendly
          }
        } catch {
          friendly = error.message || friendly
        }
        throw new Error(friendly)
      }
      return data as SyncResult
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['contacts-common'] })
      qc.invalidateQueries({ queryKey: ['google-contacts-sync-status'] })

      if (r.api_disabled) {
        toast.error(
          'Google Cloud 콘솔에서 People API 가 비활성화되어 있습니다. 관리자에게 활성화 요청 후 재시도하세요.',
          { duration: 12000 },
        )
        // 콘솔 로그로 GCP 활성화 URL 표시 (관리자가 바로 클릭 가능)
        if (r.detail) console.warn('[google-contacts-sync] api disabled detail:', r.detail)
        return
      }
      if (r.scope_missing) {
        toast.warning(
          'Google Contacts 권한이 없습니다. 로그아웃 후 다시 로그인하면 권한 부여 화면이 나타납니다.',
        )
        if (r.detail) console.warn('[google-contacts-sync] scope missing detail:', r.detail)
        return
      }
      // 저장 오류는 반드시 노출하되, 부분 성공 요약과 타조직 경고도 함께 표시
      // (early return 하면 "N개 배치 실패 + 1,800명 성공" 같은 상황이 가려짐).
      if (r.errors && r.errors.length > 0) {
        toast.error(
          `동기화 중 저장 오류 ${r.errors.length}건 (일부 배치 저장 실패): ${r.errors[0]?.message ?? ''}`,
          { duration: 12000 },
        )
      }
      const parts: string[] = []
      if (r.inserted > 0) parts.push(`신규 ${r.inserted}명`)
      if (r.duplicates > 0) parts.push(`이미 존재 ${r.duplicates}명`)
      if (r.deleted_skipped > 0) parts.push(`삭제 처리 ${r.deleted_skipped}명 (반영 안 함)`)
      // 과거 org 버그로 다른 조직에 들어간 연락처 감지 — 사용자에게 명시
      if ((r.in_other_org ?? 0) > 0) {
        toast.warning(
          `주의: 같은 이메일 연락처 ${r.in_other_org}명이 다른 조직에 있습니다. 조직 전환 후 확인하거나 관리자에게 이전을 요청하세요.`,
          { duration: 12000 },
        )
      }
      if (parts.length === 0) {
        const fetched = r.total_fetched ?? 0
        toast.success(
          fetched > 0
            ? `동기화 완료 — 가져온 ${fetched}건 모두 처리됨 (신규 없음)`
            : '동기화 완료 — 변경된 연락처 없음 (전체 다시 동기화로 재확인 가능)'
        )
      } else {
        toast.success(`동기화 완료: ${parts.join(', ')}`)
      }
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : '동기화 실패')
    },
  })
}

export function useUpdateGoogleContactsAutoSync() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      const { error } = await supabase
        .from('profiles')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ google_contacts_auto_sync: enabled } as any)
        .eq('id', user.id)
      if (error) throw error
      return enabled
    },
    onSuccess: (enabled) => {
      qc.invalidateQueries({ queryKey: ['google-contacts-sync-status'] })
      toast.success(enabled ? '자동 동기화 켜짐' : '자동 동기화 꺼짐')
    },
  })
}
