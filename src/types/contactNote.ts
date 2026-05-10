// 연락처별 수동 기록 (migration 030).
// 메일과 합쳐 timeline 으로 표시.

export type ContactNoteKind = 'call' | 'meeting' | 'note'

export interface ContactNote {
  id: string
  contact_id: string
  user_id: string
  org_id: string
  kind: ContactNoteKind
  body: string
  occurred_at: string  // 실제 발생 시각 (사용자 입력)
  created_at: string
  updated_at: string | null
}

export interface ContactNoteOption {
  value: ContactNoteKind
  label: string
  /** Tailwind 색상 — Badge 에 사용 */
  className: string
  /** lucide icon name (string ref) — 컴포넌트에서 매핑 */
  icon: 'Phone' | 'Users' | 'StickyNote'
}

export const CONTACT_NOTE_OPTIONS: ContactNoteOption[] = [
  {
    value: 'call',
    label: '통화',
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800',
    icon: 'Phone',
  },
  {
    value: 'meeting',
    label: '미팅',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
    icon: 'Users',
  },
  {
    value: 'note',
    label: '메모',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800',
    icon: 'StickyNote',
  },
]

export function contactNoteOption(k: ContactNoteKind): ContactNoteOption {
  return CONTACT_NOTE_OPTIONS.find((o) => o.value === k) ?? CONTACT_NOTE_OPTIONS[2]
}
