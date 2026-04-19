import { createContext, useContext, useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

interface AuthContextValue {
  user: User | null
  session: Session | null
  loading: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

const DEFAULT_CATEGORIES = [
  { name: '고객사별', color: '#3b82f6', icon: 'building-2', sort_order: 0 },
  { name: '업무별', color: '#22c55e', icon: 'briefcase', sort_order: 1 },
  { name: '직급별', color: '#a855f7', icon: 'user', sort_order: 2 },
  { name: '기타', color: '#6b7280', icon: 'bookmark', sort_order: 3 },
]

async function seedDefaultCategories(userId: string) {
  const { count, error: countError } = await supabase
    .from('group_categories')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)

  if (countError) {
    console.error('[seedDefaultCategories] count failed:', countError)
    return
  }

  if ((count ?? 0) === 0) {
    const { error } = await supabase.from('group_categories').insert(
      DEFAULT_CATEGORIES.map((cat) => ({ ...cat, user_id: userId }))
    )
    if (error) console.error('[seedDefaultCategories] insert failed:', error)
  }
}

async function syncProfileAndTokens(session: Session) {
  const updates: Record<string, unknown> = {
    id: session.user.id,
    email: session.user.email ?? '',
    display_name:
      session.user.user_metadata?.full_name ??
      session.user.user_metadata?.name ??
      null,
  }
  // provider_token / refresh_token 은 OAuth 완료 직후 한 번만 제공됨.
  // Google access_token 은 Google OAuth 스펙상 유효기간 1시간이므로,
  // provider_token 이 있을 때만 token_expires_at 을 Date.now() + 1hr 로 저장.
  // (session.expires_at 은 Supabase JWT 만료 시각이고 Google 토큰 만료와 별개이므로 쓰지 않는다.)
  if (session.provider_token) {
    updates.google_access_token = session.provider_token
    updates.token_expires_at = new Date(Date.now() + 3600_000).toISOString()
  }
  if (session.provider_refresh_token) {
    updates.google_refresh_token = session.provider_refresh_token
  }

  console.log('[auth] syncProfileAndTokens:', {
    hasProviderToken: !!session.provider_token,
    hasRefreshToken: !!session.provider_refresh_token,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase.from('profiles').upsert(updates as any, { onConflict: 'id' })
  if (error) {
    console.error('[auth] profile upsert failed:', error)
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
      if (session) {
        // getSession 이후 마이크로태스크에서 실행 — 다른 auth 이벤트와 순서 충돌 회피
        setTimeout(() => {
          syncProfileAndTokens(session)
          seedDefaultCategories(session.user.id)
        }, 0)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        console.log('[auth] event:', event, 'hasSession:', !!session)
        setSession(session)
        setUser(session?.user ?? null)
        setLoading(false)

        // onAuthStateChange 콜백은 auth lock 보호 하에 실행됨.
        // 콜백 안에서 await 로 supabase.from(...) 을 호출하면 lock 이 풀리지 않아
        // 이후 모든 Supabase 쿼리가 영구 대기함 (메뉴 네비게이션 먹통 버그).
        // setTimeout 0 으로 lock 밖으로 탈출시킨다.
        if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
          setTimeout(() => {
            syncProfileAndTokens(session)
            if (event === 'SIGNED_IN') {
              seedDefaultCategories(session.user.id)
            }
          }, 0)
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  const signInWithGoogle = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: [
          'openid',
          'email',
          'profile',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/gmail.compose',
          'https://mail.google.com/',
          // Drive 첨부 기능 (Phase 4)
          // drive.file: 앱이 올린/picker 로 선택한 파일에 쓰기 권한
          // drive.readonly: 사용자가 이미 Drive 에 가진 파일을 picker 로 선택할 때 읽기 권한
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/drive.readonly',
        ].join(' '),
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
        redirectTo: `${window.location.origin}/`,
      },
    })
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
