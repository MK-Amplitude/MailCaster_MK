// /outreach/callback — Outreach OAuth redirect 처리.
//
// Outreach 에서 인증 후 ?code=...&state=... 로 돌아옴.
// 1) code 를 edge function 으로 전달해 token 교환
// 2) 성공 시 settings 로 이동, 실패 시 에러 메시지

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useOutreachConnect } from '@/hooks/useOutreach'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function OutreachCallbackPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const connect = useOutreachConnect()
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // StrictMode 에서 effect 가 2번 실행되므로 가드. code 는 1회용이라 두 번 호출하면 Outreach 가 거부.
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    fired.current = true

    const code = params.get('code')
    const errCode = params.get('error')
    if (errCode) {
      setStatus('error')
      setErrorMsg(params.get('error_description') ?? errCode)
      return
    }
    if (!code) {
      setStatus('error')
      setErrorMsg('인증 코드가 없습니다. 다시 시도해주세요.')
      return
    }

    // redirect_uri 는 처음 인증 보낼 때 사용한 것과 정확히 동일해야 함.
    const redirectUri = `${window.location.origin}${import.meta.env.BASE_URL}outreach/callback`.replace(/\/+$/, '')

    connect
      .mutateAsync({ code, redirectUri })
      .then(() => {
        setStatus('success')
        setTimeout(() => navigate('/settings'), 1500)
      })
      .catch((e: Error) => {
        setStatus('error')
        setErrorMsg(e.message)
      })
  }, [params, connect, navigate])

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-sm w-full text-center space-y-4">
        {status === 'pending' && (
          <>
            <Loader2 className="w-10 h-10 animate-spin mx-auto text-primary" />
            <h1 className="text-lg font-semibold">Outreach 연결 중...</h1>
            <p className="text-sm text-muted-foreground">
              인증 정보를 안전하게 저장하고 있습니다. 잠시만 기다려주세요.
            </p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle2 className="w-10 h-10 mx-auto text-green-600" />
            <h1 className="text-lg font-semibold">Outreach 연결 완료</h1>
            <p className="text-sm text-muted-foreground">
              앞으로 발송되는 모든 메일이 Outreach 의 해당 prospect activity 에 기록됩니다.
            </p>
            <Button onClick={() => navigate('/settings')}>설정으로 돌아가기</Button>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="w-10 h-10 mx-auto text-destructive" />
            <h1 className="text-lg font-semibold">연결 실패</h1>
            <p className="text-sm text-muted-foreground break-words">{errorMsg}</p>
            <Button variant="outline" onClick={() => navigate('/settings')}>
              설정으로 돌아가기
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
