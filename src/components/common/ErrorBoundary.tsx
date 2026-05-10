// 최상위 React ErrorBoundary.
// 어떤 컴포넌트에서든 throw 가 발생하면 흰 화면 대신 친화 fallback 표시.
// 사용자가 "다시 시도" 클릭 시 reset → 재렌더 시도.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  /** fallback 을 렌더링할 때 사용 — 미지정 시 기본 메시지 */
  fallback?: (err: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // production console.* 가 drop 되더라도 ErrorBoundary 의 catch 자체는 동작.
    // 추후 Sentry 등 외부 logger 로 forward 하기 좋은 지점.
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary] caught:', error, info)
    }
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset)
      }
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
          <div className="max-w-md w-full text-center space-y-4">
            <AlertTriangle className="w-10 h-10 text-rose-500 mx-auto" />
            <div>
              <h2 className="text-lg font-semibold">문제가 발생했습니다</h2>
              <p className="text-sm text-muted-foreground mt-1">
                일시적인 오류가 발생해 화면을 표시하지 못했습니다.
              </p>
            </div>
            <details className="text-left text-xs text-muted-foreground bg-muted/40 p-3 rounded-md max-h-40 overflow-auto">
              <summary className="cursor-pointer">에러 상세</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words">
                {this.state.error.message}
              </pre>
            </details>
            <div className="flex gap-2 justify-center">
              <Button onClick={this.reset} variant="default">
                다시 시도
              </Button>
              <Button onClick={() => location.reload()} variant="outline">
                새로고침
              </Button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
