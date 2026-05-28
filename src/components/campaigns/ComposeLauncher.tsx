// 글로벌 메일 작성 launcher.
// App 어디서든 useComposeLauncher() 로 다이얼로그를 열 수 있음.
//
// 사용처:
//   - Topbar "+ 메일 작성" 버튼
//   - ContactDetailSheet "메일 작성" 버튼
//   - 받은편지함 페이지 등
//
// 동작:
//   - openCompose() — 빈 ThreadComposeDialog (mode='new') 열기
//   - openComposeToContact({ contactId, email, name }) — 특정 contact 에게 prefilled

// fast-refresh warning 무시 — Provider + hook 을 같은 파일에 두는 게 외부 사용처에 더 자연스러움.
/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { ThreadComposeDialog } from './ThreadComposeDialog'

interface ComposeTarget {
  contactId?: string | null
  email?: string
  name?: string | null
}

interface LauncherCtx {
  openCompose: (target?: ComposeTarget) => void
}

const Ctx = createContext<LauncherCtx | null>(null)

export function ComposeLauncherProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ComposeTarget | null>(null)

  const openCompose = useCallback((t?: ComposeTarget) => {
    setTarget(t ?? {})
  }, [])

  const ctxValue = useMemo<LauncherCtx>(() => ({ openCompose }), [openCompose])

  return (
    <Ctx.Provider value={ctxValue}>
      {children}
      {target && (
        <ThreadComposeDialog
          key={target.email ?? target.contactId ?? 'new'}
          open={!!target}
          onOpenChange={(o) => !o && setTarget(null)}
          mode="new"
          original={{
            gmailMessageId: null,
            gmailThreadId: null,
            subject: null,
            bodyHtml: null,
          }}
          recipient={{
            email: target.email ?? '',
            name: target.name ?? null,
            contactId: target.contactId ?? null,
            recipientId: null,
            campaignId: null,
          }}
        />
      )}
    </Ctx.Provider>
  )
}

export function useComposeLauncher(): LauncherCtx {
  const ctx = useContext(Ctx)
  if (!ctx) {
    throw new Error('useComposeLauncher must be used within ComposeLauncherProvider')
  }
  return ctx
}
