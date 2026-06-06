// thread_messages mode 의 한글 라벨 + 발신자 표시 포맷 — UI/hook 공용 단일 출처.
// (threadMessageMeta.ts 는 lucide 아이콘 의존이라 hook 에서 쓰기 무거워 순수 함수만 분리)

import type { ThreadMode } from '@/hooks/useSendThreadMessage'

/** mode → 한글 라벨. THREAD_MODE_META 의 label 과 동일 값 (단일 출처). */
export function threadModeLabel(mode: ThreadMode): string {
  switch (mode) {
    case 'followup':
      return '팔로업'
    case 'reply':
      return '회신'
    case 'forward':
      return '전달'
    case 'new':
      return '새 메일'
  }
}

/** "이름 <email>" 또는 "email" 또는 fallback. inbound/reply 발신자 표시 공용. */
export function formatSenderLabel(
  sender: { from_name?: string | null; from_email?: string | null },
  fallback = '발신자',
): string {
  if (sender.from_name && sender.from_email) {
    return `${sender.from_name} <${sender.from_email}>`
  }
  return sender.from_email || sender.from_name || fallback
}
