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
  scope_missing?: boolean
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
  return useMutation({
    mutationFn: async (opts: { forceFull?: boolean } = {}): Promise<SyncResult> => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const { data, error } = await supabase.functions.invoke('sync-google-contacts', {
        body: { force_full: opts.forceFull ?? false },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) {
        let friendly = '동기화에 실패했습니다.'
        let retryFull = false
        try {
          const resp = (error as { context?: Response }).context
          if (resp) {
            const body = (await resp.json()) as {
              error?: string
              detail?: string
              retry_with_force_full?: boolean
            }
            friendly = body.error || body.detail || friendly
            retryFull = !!body.retry_with_force_full
          }
        } catch {
          friendly = error.message || friendly
        }
        // 410 — syncToken 만료. force_full 로 자동 재시도.
        if (retryFull && !opts.forceFull) {
          const { data: retryData, error: retryErr } = await supabase.functions.invoke(
            'sync-google-contacts',
            {
              body: { force_full: true },
              headers: { Authorization: `Bearer ${accessToken}` },
            },
          )
          if (retryErr) throw new Error(friendly)
          return retryData as SyncResult
        }
        throw new Error(friendly)
      }
      return data as SyncResult
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['contacts-common'] })
      qc.invalidateQueries({ queryKey: ['google-contacts-sync-status'] })

      if (r.scope_missing) {
        toast.warning(
          'Google Contacts 권한이 없습니다. 로그아웃 후 다시 로그인하면 권한 부여 화면이 나타납니다.',
        )
        return
      }
      const parts: string[] = []
      if (r.inserted > 0) parts.push(`신규 ${r.inserted}명`)
      if (r.duplicates > 0) parts.push(`이미 존재 ${r.duplicates}명`)
      if (r.deleted_skipped > 0) parts.push(`삭제 처리 ${r.deleted_skipped}명 (반영 안 함)`)
      if (parts.length === 0) {
        toast.success('동기화 완료 — 새 연락처 없음')
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
