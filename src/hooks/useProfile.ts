import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { toast } from 'sonner'

// ============================================================
// useProfile — mailcaster.profiles 자기 row 조회/수정
// ------------------------------------------------------------
// profiles 는 auth.users 와 1:1. user_id 가 곧 profile.id.
//
// 보안:
//   - Google 토큰 컬럼(google_access_token/refresh_token/token_expires_at)
//     은 사용자가 UI 에서 수정할 값이 아니므로 Update 타입에서 제외한다.
//   - RLS 가 auth.uid()=id 를 강제하므로 클라이언트가 타 사용자 row 에
//     접근할 수 없음.
//
// 캐시 키: ['profile', userId] — 유저가 바뀌면 다른 쿼리.
// ============================================================

const QK = 'profile'

export interface Profile {
  id: string
  email: string
  display_name: string | null
  signature_html: string | null
  default_sender_name: string | null
  default_cc: string | null
  default_bcc: string | null
  slack_webhook_url: string | null
  slack_channel_name: string | null
  daily_send_count: number
  daily_send_count_date: string | null
  daily_send_limit: number
  created_at: string
}

/** UI 에서 수정 가능한 필드만 — 토큰류는 제외 */
export type ProfileEditable = Partial<
  Pick<
    Profile,
    | 'display_name'
    | 'default_sender_name'
    | 'default_cc'
    | 'default_bcc'
    | 'slack_webhook_url'
    | 'slack_channel_name'
    | 'daily_send_limit'
  >
>

export function useProfile() {
  const { user } = useAuth()

  return useQuery({
    queryKey: [QK, user?.id],
    queryFn: async () => {
      if (!user) throw new Error('로그인이 필요합니다.')
      const { data, error } = await supabase
        .from('profiles')
        .select(
          'id, email, display_name, signature_html, default_sender_name, default_cc, default_bcc, slack_webhook_url, slack_channel_name, daily_send_count, daily_send_count_date, daily_send_limit, created_at',
        )
        .eq('id', user.id)
        .single()
      if (error) throw error
      return data as Profile
    },
    enabled: !!user,
  })
}

export function useUpdateProfile() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (updates: ProfileEditable) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      // 빈 문자열은 null 로 정규화 — DB 에 "" vs null 혼재 방지
      // 타입은 ProfileEditable 그대로 유지 (Supabase 가 Update 타입 추론에 사용).
      const normalized: ProfileEditable = {}
      for (const [k, v] of Object.entries(updates) as [
        keyof ProfileEditable,
        ProfileEditable[keyof ProfileEditable],
      ][]) {
        if (typeof v === 'string') {
          const trimmed = v.trim()
          // daily_send_limit 는 number 라 여기 안 들어옴 — 문자열 필드만 정규화
          ;(normalized as Record<string, string | null>)[k] =
            trimmed === '' ? null : trimmed
        } else if (v !== undefined) {
          ;(normalized as Record<string, unknown>)[k] = v
        }
      }

      const { error } = await supabase
        .from('profiles')
        .update(normalized)
        .eq('id', user.id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('설정이 저장되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[updateProfile] failed:', e)
      toast.error(e.message || '저장 실패')
    },
  })
}
