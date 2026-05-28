// thread_messages 의 mode (팔로업/회신/전달) 와 status (pending/sent/failed) 메타데이터.
// ThreadMessagesSection 의 리스트 행과 ThreadMessageDetailDialog 의 상세 모달 양쪽에서 사용.
//
// 디자인 결정:
//   - badgeClass 는 둘 다 동일 → 한 키로 export
//   - status 의 label 은 컴포넌트마다 미세 차이가 있어 short / long 두 가지 제공

import {
  Reply,
  ReplyAll,
  Forward,
  Mail,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react'
import type { ThreadMessageRow } from '@/hooks/useThreadMessages'

export const THREAD_MODE_META: Record<
  ThreadMessageRow['mode'],
  { label: string; Icon: typeof Reply; badgeClass: string }
> = {
  followup: {
    label: '팔로업',
    Icon: Reply,
    badgeClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  },
  reply: {
    label: '회신',
    Icon: ReplyAll,
    badgeClass: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  },
  forward: {
    label: '전달',
    Icon: Forward,
    badgeClass: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  },
  new: {
    label: '새 메일',
    Icon: Mail,
    badgeClass: 'bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300',
  },
}

export const THREAD_STATUS_META: Record<
  ThreadMessageRow['status'],
  { Icon: typeof CheckCircle2; color: string; shortLabel: string; longLabel: string }
> = {
  pending: {
    Icon: Clock,
    color: 'text-amber-600 dark:text-amber-400',
    shortLabel: '발송 중',
    longLabel: '발송 중',
  },
  sent: {
    Icon: CheckCircle2,
    color: 'text-green-600 dark:text-green-400',
    shortLabel: '성공',
    longLabel: '발송 성공',
  },
  failed: {
    Icon: XCircle,
    color: 'text-red-600 dark:text-red-400',
    shortLabel: '실패',
    longLabel: '발송 실패',
  },
}
