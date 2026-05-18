import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// 다크모드 초기화 (localStorage 우선)
const theme = localStorage.getItem('theme')
if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark')
}

// ─────────────────────────────────────────────────────────────────────────────
// Stale chunk 자동 복구 — 새 배포 후 사용자 탭이 옛 hash 의 lazy chunk 를 가져오려 할 때
//   "Failed to fetch dynamically imported module ... assets/XxxPage-HASH.js" 에러 발생.
//   index.html 만 새로고침하면 정상 해결되므로 자동으로 1회 reload.
//   sessionStorage 플래그로 무한 loop 방지 (reload 했는데도 또 같은 에러면 사용자에게 노출).
// ─────────────────────────────────────────────────────────────────────────────
const RELOAD_FLAG = 'mailcaster:stale-chunk-reloaded'

function isChunkLoadError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : (err as { message?: string })?.message ?? ''
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  )
}

function tryReloadOnce(reason: string) {
  if (sessionStorage.getItem(RELOAD_FLAG)) {
    // 이미 한 번 reload 했는데도 또 stale → 진짜 문제. 사용자에게 노출.
    return false
  }
  sessionStorage.setItem(RELOAD_FLAG, '1')
  console.warn('[main] stale chunk detected — reloading:', reason)
  // basename + cache-bust 파라미터로 새 index.html 강제 fetch
  const url = new URL(window.location.href)
  url.searchParams.set('_r', Date.now().toString())
  window.location.replace(url.toString())
  return true
}

// 정상 진입 시 flag 제거 — 다음 stale 발생 시 다시 한 번 reload 가능.
// (App 이 정상 마운트되어 sessionStorage 접근하는 시점이면 stale 이 아닌 상태)
queueMicrotask(() => {
  // 약간 늦춰서 — chunk 로딩이 비동기라 마운트 직후 실패할 수 있음.
  setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5000)
})

window.addEventListener('error', (e) => {
  if (isChunkLoadError(e.error ?? e.message)) tryReloadOnce('window.error')
})
window.addEventListener('unhandledrejection', (e) => {
  if (isChunkLoadError(e.reason)) tryReloadOnce('unhandledrejection')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
