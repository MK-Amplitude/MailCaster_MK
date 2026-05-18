// Outreach 연동 — OAuth connect/disconnect + mailing sync (수동 백필).
//
// 발송 시점 자동 sync 는 useSendCampaign / send-scheduled-campaigns 가 직접 호출.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { useAuth } from './useAuth'

// Outreach OAuth Authorization URL 구성.
// VITE_OUTREACH_CLIENT_ID 가 비어 있으면 연동 미설정 — UI 가 안내 메시지 표시.
export function getOutreachAuthUrl(redirectUri: string, state: string): string | null {
  const clientId = import.meta.env.VITE_OUTREACH_CLIENT_ID as string | undefined
  if (!clientId) return null
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'prospects.read prospects.write mailings.read mailings.write users.read users.all',
    state,
  })
  return `https://accounts.outreach.io/oauth/authorize?${params.toString()}`
}

// 현재 사용자의 Outreach 연결 상태 — profiles 의 outreach_connected_at 으로 판단.
export function useOutreachStatus() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['outreach-status', user?.id],
    queryFn: async () => {
      if (!user) return { connected: false }
      const { data, error } = await supabase
        .from('profiles')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .select('outreach_connected_at, outreach_user_id' as any)
        .eq('id', user.id)
        .single()
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      return {
        connected: !!p?.outreach_connected_at,
        connected_at: p?.outreach_connected_at as string | null,
        outreach_user_id: p?.outreach_user_id as number | null,
      }
    },
    enabled: !!user,
  })
}

// code → token 교환 (frontend callback 페이지에서 호출).
export function useOutreachConnect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (params: { code: string; redirectUri: string }) => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const { data, error } = await supabase.functions.invoke('outreach-oauth', {
        body: { code: params.code, redirect_uri: params.redirectUri },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) {
        let friendly = 'Outreach 연결에 실패했습니다.'
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
      return data as { connected: true; outreach_email?: string }
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['outreach-status'] })
      toast.success(
        r.outreach_email
          ? `Outreach 연결됨 (${r.outreach_email})`
          : 'Outreach 연결됨',
      )
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Outreach 연결 실패'),
  })
}

export function useOutreachDisconnect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')
      const { error } = await supabase.functions.invoke('outreach-disconnect', {
        body: {},
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['outreach-status'] })
      toast.success('Outreach 연결이 해제되었습니다.')
    },
    onError: () => toast.error('연결 해제 실패'),
  })
}

// recipient_ids 를 Outreach 로 동기화 — 발송 직후 fire-and-forget 또는 수동 백필.
export function useOutreachSyncMailings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (recipientIds: string[]) => {
      if (recipientIds.length === 0) return { synced: 0, skipped: 0, errors: 0 }
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')
      const { data, error } = await supabase.functions.invoke('outreach-sync-mailing', {
        body: { recipient_ids: recipientIds },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) throw error
      return data as { synced: number; skipped: number; errors: number }
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['campaigns', 'recipients'] })
      if (r.synced > 0) toast.success(`Outreach 동기화 ${r.synced}건 완료`)
      else if (r.errors > 0) toast.error(`Outreach 동기화 실패 ${r.errors}건`)
    },
  })
}
