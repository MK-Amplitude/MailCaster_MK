// CampaignWizardPage 공통 헬퍼 — pure 함수만 모음.
// (UI / state 의존성 없는 것만 — testable)

/** 같은 이메일(case-insensitive)이 여러 번 들어와도 첫 등장만 유지 */
export function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of emails) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

// "테이블 없음" 에러 감지 — migration 미적용 시나리오를 자연스럽게 처리.
//   - 42P01  : PostgreSQL undefined_table
//   - PGRST205: PostgREST schema cache miss
//   - 메시지 패턴 두 종(릴리스 차이로 code 가 누락된 경우 대비)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isMissingTableError(err: any): boolean {
  const msg: string = err?.message ?? ''
  return (
    err?.code === '42P01' ||
    err?.code === 'PGRST205' ||
    /relation .* does not exist/i.test(msg) ||
    /could not find the table/i.test(msg)
  )
}

/** ISO → "YYYY-MM-DDTHH:mm" (datetime-local input 값) — 로컬 시간대 기준 */
export function toLocalInputValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "YYYY-MM-DDTHH:mm" → ISO. 잘못된 입력은 null. */
export function fromLocalInputValue(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

/** 미래 시각까지 남은 시간을 "5분", "2시간", "3일" 같은 한국어로 */
export function formatRelativeFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return '지금'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}분`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}시간`
  const day = Math.round(hr / 24)
  return `${day}일`
}
