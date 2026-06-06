// 답장 자동 분류 — recipients.reply_category (migration 028, 'unsubscribe' 추가 061)
//
// LLM 이 답장 본문 톤을 분류해 영업 우선순위를 판단하기 쉽게 한다.
// 6종 + null(미분류). 새 답장은 check-replies edge function 이 자동 분류.
// 'unsubscribe' 는 명시적 수신거부 의사 — check-replies 가 자동으로 unsubscribes 등록.

export type ReplyCategory =
  | 'interested'
  | 'not_interested'
  | 'question'
  | 'out_of_office'
  | 'unclear'
  | 'unsubscribe'

export interface ReplyCategoryOption {
  value: ReplyCategory
  /** 한국어 라벨 (badge / select) */
  label: string
  /** 한 줄 설명 (tooltip) */
  hint: string
  /** Tailwind 색상 — Badge 에서 그대로 사용 */
  className: string
  /** sort/우선순위 — 영업 액션 시급도 (낮을수록 위) */
  priority: number
}

export const REPLY_CATEGORY_OPTIONS: ReplyCategoryOption[] = [
  {
    value: 'interested',
    label: '관심',
    hint: '미팅·후속 컨택 의향이 있는 답장 — 빠른 팔로업 권장',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
    priority: 0,
  },
  {
    value: 'question',
    label: '질문',
    hint: '구체 질문/자료 요청 — 응답 필요',
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800',
    priority: 1,
  },
  {
    value: 'not_interested',
    label: '거절',
    hint: '정중한 거절 — 추가 푸시 자제 권장',
    className:
      'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border-rose-200 dark:border-rose-800',
    priority: 2,
  },
  {
    value: 'unsubscribe',
    label: '수신거부',
    hint: '명시적 수신거부 요청 — 자동으로 수신거부 등록됨 (이후 발송 제외)',
    className:
      'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 border-zinc-300 dark:border-zinc-700',
    priority: 3,
  },
  {
    value: 'out_of_office',
    label: '부재중',
    hint: '자동응답·휴가 — 인간 액션 불필요',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800',
    priority: 4,
  },
  {
    value: 'unclear',
    label: '분류 불가',
    hint: '톤이 모호하거나 분류 신뢰도 낮음 — 직접 확인',
    className: 'bg-muted text-muted-foreground border-border',
    priority: 5,
  },
]

export function replyCategoryLabel(c: ReplyCategory | null | undefined): string {
  if (!c) return '미분류'
  return REPLY_CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c
}

export function replyCategoryOption(
  c: ReplyCategory | null | undefined
): ReplyCategoryOption | null {
  if (!c) return null
  return REPLY_CATEGORY_OPTIONS.find((o) => o.value === c) ?? null
}
