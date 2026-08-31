import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import type { Organization, OrgRole } from '@/types/org'

type OrgWithRole = Organization & { role: OrgRole }

interface AuthContextValue {
  user: User | null
  session: Session | null
  loading: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>

  // 조직 상태 — Phase 7
  orgs: OrgWithRole[]
  currentOrg: OrgWithRole | null
  orgsLoading: boolean
  setCurrentOrg: (org: OrgWithRole) => void
  refreshOrgs: () => void
  // 현재 조직에서 owner/admin 여부 — RLS 가 "own or admin" 을 허용하는 테이블의
  // 수정/삭제 버튼 가시성을 UI 에서도 맞추기 위한 헬퍼.
  isOrgAdmin: boolean
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

const CURRENT_ORG_STORAGE_KEY = 'mailcaster-current-org-id'

// ─────────────────────────────────────────────────────────────
// OAuth 복귀 실패 표면화 — Google 에서 돌아왔는데 세션 교환이 실패하면
// 지금까지는 아무 메시지 없이 로그인 화면으로 되돌아가 "그냥 안 됨"으로 보였다.
// supabase-js 가 code 교환 후 URL 을 정리(replaceState)하기 전에, 모듈 로드
// 시점에 쿼리 파라미터를 스냅샷해 두고 초기 세션 판정 후 실패 원인을 토스트로 노출.
// (PKCE verifier 유실 — 홈 화면 PWA/인앱 브라우저에서 로그인 시 흔함 — 이 대표 원인)
// ─────────────────────────────────────────────────────────────
const initialUrl = typeof window !== 'undefined' ? new URL(window.location.href) : null
const oauthReturnError =
  initialUrl?.searchParams.get('error_description') ?? initialUrl?.searchParams.get('error') ?? null
const hadOAuthCode = initialUrl?.searchParams.has('code') ?? false

// 기본 카테고리는 이제 DB trigger (016) 가 삽입 — 이전의 프런트엔드 seed 는 비활성화.
// (남은 호출이 있어도 group_categories UNIQUE(user_id, name) 때문에 중복 생성되지 않음.)

async function syncProfileAndTokens(session: Session) {
  // 1) 프로필 기본 정보 (토큰 제외) — 항상 직접 upsert.
  const updates: Record<string, unknown> = {
    id: session.user.id,
    email: session.user.email ?? '',
    display_name:
      session.user.user_metadata?.full_name ??
      session.user.user_metadata?.name ??
      null,
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

  // 2) Google provider 토큰 — 서버 (store-google-tokens) 경유로 저장.
  //    refresh_token 은 서버에서 암호화 후 저장 (TOKEN_ENCRYPTION_KEY 설정 시).
  //    provider_token / refresh_token 은 OAuth 완료 직후 한 번만 제공됨.
  if (session.provider_token || session.provider_refresh_token) {
    const { error: storeErr } = await supabase.functions.invoke('store-google-tokens', {
      body: {
        access_token: session.provider_token ?? undefined,
        refresh_token: session.provider_refresh_token ?? undefined,
      },
    })
    if (storeErr) {
      // 서버 저장 실패 시 로그인 자체가 막히면 안 되므로 기존 직접 저장으로 폴백 (평문).
      console.warn('[auth] store-google-tokens failed, fallback to direct upsert:', storeErr)
      const tokenUpdates: Record<string, unknown> = { id: session.user.id }
      if (session.provider_token) {
        tokenUpdates.google_access_token = session.provider_token
        tokenUpdates.token_expires_at = new Date(Date.now() + 3600_000).toISOString()
      }
      if (session.provider_refresh_token) {
        tokenUpdates.google_refresh_token = session.provider_refresh_token
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: fbErr } = await supabase.from('profiles').upsert(tokenUpdates as any, { onConflict: 'id' })
      if (fbErr) console.error('[auth] token fallback upsert failed:', fbErr)
    }
  }
}

// 로그인 직후 내 이메일로 온 미수락 초대를 자동 수락.
// trigger 가 아니라 RPC 로 만든 이유는 016 참고.
async function acceptPendingInvitations() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)('accept_pending_invitations')
    if (error) {
      console.warn('[auth] accept_pending_invitations failed:', error)
      return 0
    }
    return (data as number) ?? 0
  } catch (e) {
    console.warn('[auth] accept_pending_invitations threw:', e)
    return 0
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  // 사용자가 고른 현재 조직 id — localStorage 영속화
  const [currentOrgId, setCurrentOrgIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem(CURRENT_ORG_STORAGE_KEY)
  })

  const qc = useQueryClient()

  // ======================================================
  // 세션 관리
  // ======================================================
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
      // Google 에서 돌아왔는데(에러 파라미터 또는 code 존재) 세션이 안 만들어진 경우
      // — 실패 원인을 사용자에게 보여준다. getSession 은 내부적으로 URL 의 code
      // 교환(detectSessionInUrl)까지 끝난 뒤 resolve 되므로 여기서 판정 가능.
      if (!session && (oauthReturnError || hadOAuthCode)) {
        toast.error(
          oauthReturnError
            ? `로그인 실패: ${oauthReturnError}`
            : '로그인 처리에 실패했습니다. 홈 화면 앱이나 카카오톡 등 인앱 브라우저가 아닌 Safari/Chrome 브라우저에서 직접 접속해 다시 시도해주세요.',
          { duration: 20000 },
        )
      }
      if (session) {
        // getSession 이후 마이크로태스크에서 실행 — 다른 auth 이벤트와 순서 충돌 회피
        setTimeout(() => {
          syncProfileAndTokens(session)
          acceptPendingInvitations().then((count) => {
            if (count > 0) qc.invalidateQueries({ queryKey: ['orgs'] })
          })
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
              acceptPendingInvitations().then((count) => {
                if (count > 0) qc.invalidateQueries({ queryKey: ['orgs'] })
              })
            }
          }, 0)
        }

        // 로그아웃 시 현재 조직 선택도 초기화
        if (event === 'SIGNED_OUT') {
          setCurrentOrgIdState(null)
          localStorage.removeItem(CURRENT_ORG_STORAGE_KEY)
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [qc])

  // ======================================================
  // 조직 목록
  // ======================================================
  const orgsQuery = useQuery({
    queryKey: ['orgs', user?.id],
    queryFn: async (): Promise<OrgWithRole[]> => {
      // org_members + organizations 조인 — RLS 가 자동 필터
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('org_members') as any)
        .select('role, organizations(id, name, slug, created_by, created_at, updated_at)')
        .eq('user_id', user!.id)
        .order('joined_at', { ascending: true })
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((row: any) => ({ ...row.organizations, role: row.role }))
    },
    enabled: !!user,
    staleTime: 1000 * 60 * 5,
  })

  const orgs = useMemo(() => orgsQuery.data ?? [], [orgsQuery.data])

  // 현재 조직: localStorage 가 유효하면 그것, 아니면 첫번째 조직
  const currentOrg = useMemo<OrgWithRole | null>(() => {
    if (orgs.length === 0) return null
    const saved = orgs.find((o) => o.id === currentOrgId)
    return saved ?? orgs[0]
  }, [orgs, currentOrgId])

  // orgs 가 로드되면 currentOrgId 가 더 이상 유효하지 않은 경우 자동 교정
  useEffect(() => {
    if (orgs.length === 0) return
    const valid = orgs.some((o) => o.id === currentOrgId)
    if (!valid) {
      const nextId = orgs[0].id
      setCurrentOrgIdState(nextId)
      localStorage.setItem(CURRENT_ORG_STORAGE_KEY, nextId)
    }
  }, [orgs, currentOrgId])

  const setCurrentOrg = useCallback(
    (org: OrgWithRole) => {
      setCurrentOrgIdState(org.id)
      localStorage.setItem(CURRENT_ORG_STORAGE_KEY, org.id)
      // 조직 전환 — 모든 리소스 쿼리 invalidate.
      // queryKey 에 currentOrg.id 가 포함돼 있어도 invalidate 해야 active 쿼리가
      // 즉시 refetch 된다 (단순히 key 가 바뀐 건 과거 캐시를 그대로 두고 새 fetch 를 시작할 뿐).
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['contacts-common'] })
      qc.invalidateQueries({ queryKey: ['groups'] })
      qc.invalidateQueries({ queryKey: ['group-categories'] })
      qc.invalidateQueries({ queryKey: ['templates'] })
      qc.invalidateQueries({ queryKey: ['signatures'] })
      qc.invalidateQueries({ queryKey: ['campaigns'] })
      qc.invalidateQueries({ queryKey: ['unsubscribes'] })
      qc.invalidateQueries({ queryKey: ['blacklist'] })
    },
    [qc]
  )

  const refreshOrgs = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['orgs'] })
  }, [qc])

  const isOrgAdmin = useMemo(
    () => currentOrg?.role === 'owner' || currentOrg?.role === 'admin',
    [currentOrg?.role]
  )

  // ======================================================
  // Auth 액션
  // ======================================================
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
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/drive.readonly',
          // Calendar 통합 (Phase 11.2) — 미팅을 contact timeline 에 인입.
          // 기존 사용자는 한 번 더 로그인해야 권한 부여됨.
          'https://www.googleapis.com/auth/calendar.readonly',
          // Google Contacts 동기화 (Phase 14) — 리멤버 → 구글 주소록 → MailCaster.
          // 기존 사용자는 한 번 더 로그인해야 권한 부여됨.
          'https://www.googleapis.com/auth/contacts.readonly',
          // 기타 주소록 (Other contacts) 동기화 — Gmail 이 자동 수집한 상대.
          // 기존 사용자는 한 번 더 로그인해야 권한 부여됨.
          'https://www.googleapis.com/auth/contacts.other.readonly',
        ].join(' '),
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
        redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
      },
    })
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        signInWithGoogle,
        signOut,
        orgs,
        currentOrg,
        orgsLoading: orgsQuery.isLoading,
        setCurrentOrg,
        refreshOrgs,
        isOrgAdmin,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// AuthProvider 와 같은 파일에서 useAuth 훅을 export — 컨텍스트 정의가 한 곳.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
