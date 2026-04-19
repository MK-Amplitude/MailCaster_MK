import { useId, useRef, useState, type KeyboardEvent, type ClipboardEvent, type FocusEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EmailChipInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
  /** 상한 (초과 시 추가 금지). 0/undefined = 제한 없음. */
  max?: number
}

// 아주 느슨한 RFC 5322 단순화 — 프로덕션에서 흔히 쓰는 정도면 충분
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/

function normalize(raw: string): string {
  return raw.trim().replace(/^[<"']+|[>"'.,;\s]+$/g, '')
}

/**
 * 이메일 칩 입력:
 *   - Enter / , / ; / Tab / blur 시 현재 텍스트를 칩으로 확정
 *   - 붙여넣기(paste) 로 여러 개를 한꺼번에 추가 (콤마·세미콜론·공백·개행 구분)
 *   - 각 칩에 우측 × 버튼으로 제거
 *   - 잘못된 이메일은 제목 색을 붉게 표시, 중복은 조용히 스킵
 */
export function EmailChipInput({
  value,
  onChange,
  placeholder,
  className,
  disabled,
  id,
  'aria-label': ariaLabel,
  max,
}: EmailChipInputProps) {
  const [draft, setDraft] = useState('')
  // 같은 페이지에 여러 개 (Cc + Bcc) 를 동시에 써도 id 충돌 안 나게 고유 id 자동 생성.
  // 이전엔 fallback id 가 '__email_chip_input__' 로 하드코딩돼 두 번째 인스턴스가
  // 포커스를 못 받는 버그가 있었다.
  const autoId = useId()
  const inputId = id ?? `email-chip-${autoId}`
  const inputRef = useRef<HTMLInputElement | null>(null)

  const addMany = (candidates: string[]) => {
    if (disabled) return
    const existing = new Set(value.map((v) => v.toLowerCase()))
    const next = [...value]
    for (const raw of candidates) {
      const e = normalize(raw)
      if (!e) continue
      if (!EMAIL_RE.test(e)) continue
      const key = e.toLowerCase()
      if (existing.has(key)) continue
      if (max && next.length >= max) break
      existing.add(key)
      next.push(e)
    }
    if (next.length !== value.length) onChange(next)
  }

  const commitDraft = () => {
    if (!draft.trim()) {
      setDraft('')
      return
    }
    addMany(draft.split(/[\s,;]+/))
    setDraft('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
      if (draft.trim()) {
        e.preventDefault()
        commitDraft()
      }
      return
    }
    if (e.key === 'Backspace' && !draft && value.length > 0) {
      e.preventDefault()
      onChange(value.slice(0, -1))
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!text) return
    if (/[\s,;]/.test(text)) {
      e.preventDefault()
      addMany(text.split(/[\s,;]+/))
      setDraft('')
    }
  }

  const handleBlur = (_e: FocusEvent<HTMLInputElement>) => {
    commitDraft()
  }

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
  }

  const draftInvalid = draft.trim() !== '' && !EMAIL_RE.test(normalize(draft))

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 min-h-10 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      onClick={() => {
        // 전체 영역 클릭 시 입력에 포커스 — ref 사용 (id 는 비상용 fallback)
        inputRef.current?.focus()
      }}
    >
      {value.map((email, idx) => (
        <span
          key={`${email}-${idx}`}
          className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-foreground"
        >
          {email}
          {!disabled && (
            <button
              type="button"
              aria-label={`${email} 제거`}
              className="text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation()
                removeAt(idx)
              }}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        id={inputId}
        aria-label={ariaLabel}
        type="email"
        className={cn(
          'flex-1 min-w-[120px] bg-transparent outline-none placeholder:text-muted-foreground',
          draftInvalid && 'text-destructive',
        )}
        placeholder={value.length === 0 ? placeholder : ''}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={handleBlur}
      />
    </div>
  )
}
