import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Loader2, MailX, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// ------------------------------------------------------------
// 공개 수신거부 페이지 (C-2 / C-3) — 메일 하단 '수신거부' 링크의 착지점.
//   ${APP_BASE_URL}/unsubscribe?t=<token>
// 로그인 불필요, 앱 레이아웃(사이드바 등) 없이 단독 렌더 (App.tsx 에서 ProtectedRoute 밖에 등록).
// Supabase 기본 도메인(*.supabase.co)은 text/html 을 text/plain 으로 내려보내므로 사람이 보는
// 확인 화면은 GitHub Pages 에 두고, 실제 처리는 unsubscribe Edge Function 에 JSON POST 한다.
// GET 으로는 절대 처리하지 않는다 — 메일 보안 스캐너의 링크 프리페치가 수신거부를 일으키지 않도록
// 사용자가 버튼을 눌러야만 POST 가 나간다.
// ------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_TIMEOUT_MS = 15_000

type Phase =
  | { kind: 'confirm' }
  | { kind: 'submitting' }
  | { kind: 'done'; emailMasked: string | null }
  | { kind: 'error'; message: string }

// D-2 미리보기 — 버튼을 누르기 전에 "어느 주소가 수신거부되는지" 보여준다 (CC/BCC 수신자가
// 자기 주소가 아님을 알아볼 수 있도록). 부작용 없음. 실패해도 버튼은 그대로 쓸 수 있다.
type Preview =
  | { kind: 'loading' }
  | { kind: 'ready'; found: boolean; emailMasked: string | null; already: boolean }
  | { kind: 'unavailable' }

type UnsubscribeResponse = {
  ok?: boolean
  found?: unknown
  email_masked?: unknown
  already?: unknown
  error?: unknown
}

function unsubscribeEndpoint(): { url: string; anonKey: string } | null {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!baseUrl || !anonKey) return null
  return { url: `${baseUrl.replace(/\/+$/, '')}/functions/v1/unsubscribe`, anonKey }
}

async function postUnsubscribe(
  payload: { t: string; preview?: true },
  signal: AbortSignal,
): Promise<{ res: Response; body: UnsubscribeResponse | null } | null> {
  const ep = unsubscribeEndpoint()
  if (!ep) return null
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: ep.anonKey,
    },
    body: JSON.stringify(payload),
    signal,
  })
  let body: UnsubscribeResponse | null = null
  try {
    body = (await res.json()) as UnsubscribeResponse
  } catch {
    body = null
  }
  return { res, body }
}

export default function UnsubscribePage() {
  const [params] = useSearchParams()
  const token = useMemo(() => (params.get('t') ?? '').trim(), [params])
  const tokenValid = UUID_RE.test(token)
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' })
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' })

  useEffect(() => {
    if (!tokenValid) return
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    let cancelled = false
    void (async () => {
      try {
        const out = await postUnsubscribe({ t: token, preview: true }, ctrl.signal)
        if (cancelled) return
        const body = out?.body
        if (!out || !out.res.ok || !body?.ok) {
          setPreview({ kind: 'unavailable' })
          return
        }
        const found = body.found === true
        setPreview({
          kind: 'ready',
          found,
          emailMasked:
            found && typeof body.email_masked === 'string' && body.email_masked
              ? body.email_masked
              : null,
          already: found && body.already === true,
        })
      } catch {
        if (!cancelled) setPreview({ kind: 'unavailable' })
      } finally {
        clearTimeout(timer)
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [token, tokenValid])

  useEffect(() => {
    const prev = document.title
    document.title = '메일 수신거부'
    return () => {
      document.title = prev
    }
  }, [])

  const submit = async () => {
    if (!tokenValid || phase.kind === 'submitting') return
    if (!unsubscribeEndpoint()) {
      setPhase({ kind: 'error', message: '서비스 설정 오류로 요청을 보낼 수 없습니다. 메일에 "수신거부"라고 회신해 주세요.' })
      return
    }
    setPhase({ kind: 'submitting' })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const out = await postUnsubscribe({ t: token }, ctrl.signal)
      if (!out) {
        setPhase({ kind: 'error', message: '서비스 설정 오류로 요청을 보낼 수 없습니다. 메일에 "수신거부"라고 회신해 주세요.' })
        return
      }
      const { res, body } = out
      if (!res.ok || !body?.ok) {
        setPhase({
          kind: 'error',
          message:
            res.status === 400
              ? '수신거부 링크가 올바르지 않습니다. 메일에 있는 링크를 다시 눌러 주시거나, 메일에 "수신거부"라고 회신해 주세요.'
              : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주시거나, 메일에 "수신거부"라고 회신해 주세요.',
        })
        return
      }
      // 서버는 토큰 열거 방지를 위해 미존재 토큰에도 {ok:true} 를 준다 — 처리 결과(email_masked)가
      // 없으면 실제로 기록되지 않은 것이므로 "완료"라고 안내하면 안 된다. 회신 수신거부로 유도.
      const masked =
        typeof body.email_masked === 'string' && body.email_masked ? body.email_masked : null
      if (!masked) {
        setPhase({
          kind: 'error',
          message:
            '수신거부 대상을 확인할 수 없습니다. 번거로우시겠지만 받으신 메일에 "수신거부"라고 회신해 주시면 처리됩니다.',
        })
        return
      }
      setPhase({ kind: 'done', emailMasked: masked })
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      setPhase({
        kind: 'error',
        message: aborted
          ? '응답이 지연되고 있습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'
          : '네트워크 오류로 요청을 보내지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.',
      })
    } finally {
      clearTimeout(timer)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4 py-10">
      <Card className="w-full max-w-md">
        {!tokenValid ? (
          <>
            <CardHeader className="items-center text-center">
              <AlertCircle className="w-10 h-10 text-muted-foreground mb-2" />
              <CardTitle className="text-xl">유효하지 않은 수신거부 링크</CardTitle>
              <CardDescription>
                링크가 잘렸거나 올바르지 않습니다. 받으신 메일의 '수신거부' 링크를 다시 눌러 주시거나,
                메일에 "수신거부"라고 회신해 주시면 처리해 드립니다.
              </CardDescription>
            </CardHeader>
          </>
        ) : phase.kind === 'done' ? (
          <>
            <CardHeader className="items-center text-center">
              <CheckCircle2 className="w-10 h-10 text-green-600 dark:text-green-400 mb-2" />
              <CardTitle className="text-xl">
                수신거부가 완료되었습니다{phase.emailMasked ? ` (${phase.emailMasked})` : ''}
              </CardTitle>
              <CardDescription>
                앞으로 이 발신자로부터 홍보성 메일이 발송되지 않습니다. 이 창은 닫으셔도 됩니다.
              </CardDescription>
            </CardHeader>
          </>
        ) : (
          <>
            <CardHeader className="items-center text-center">
              <MailX className="w-10 h-10 text-muted-foreground mb-2" />
              <CardTitle className="text-xl">메일 수신거부</CardTitle>
              <CardDescription>
                아래 버튼을 누르면 이 메일의 받는 사람(To) 주소로 더 이상 홍보성 메일이 발송되지
                않습니다. 참조(CC)·숨은참조(BCC)로 받으셨다면 이 버튼은 받는 사람의 수신을 거부하게
                되니 누르지 마시고, 발신자에게 "수신거부"라고 회신해 주세요.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-3">
              <div
                className="w-full rounded-md border bg-muted/40 px-3 py-2 text-sm text-center"
                aria-live="polite"
              >
                {preview.kind === 'loading' ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    수신거부 대상 확인 중…
                  </span>
                ) : preview.kind === 'ready' && preview.emailMasked ? (
                  <>
                    <div>
                      수신거부 대상: <span className="font-medium">{preview.emailMasked}</span>
                    </div>
                    {preview.already && (
                      <div className="text-xs text-muted-foreground mt-1">
                        이미 수신거부된 주소입니다. 다시 누르셔도 그대로 유지됩니다.
                      </div>
                    )}
                    {!preview.already && (
                      <div className="text-xs text-muted-foreground mt-1">
                        본인 주소가 아니라면 버튼을 누르지 마세요.
                      </div>
                    )}
                  </>
                ) : preview.kind === 'ready' && !preview.found ? (
                  <span className="text-muted-foreground">
                    이 링크로는 수신거부 대상을 찾을 수 없습니다. 받으신 메일에
                    &quot;수신거부&quot;라고 회신해 주시면 처리됩니다.
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    수신거부 대상 주소를 미리 확인하지 못했습니다. 이 메일의 받는 사람(To)이
                    본인일 때만 버튼을 눌러 주세요.
                  </span>
                )}
              </div>
              {phase.kind === 'error' && (
                <p className="text-sm text-red-600 dark:text-red-400 text-center" role="alert">
                  {phase.message}
                </p>
              )}
              <Button
                className="w-full"
                onClick={submit}
                disabled={
                  phase.kind === 'submitting' || (preview.kind === 'ready' && !preview.found)
                }
              >
                {phase.kind === 'submitting' ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    처리 중
                  </>
                ) : phase.kind === 'error' ? (
                  '다시 시도'
                ) : (
                  '수신거부'
                )}
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  )
}
