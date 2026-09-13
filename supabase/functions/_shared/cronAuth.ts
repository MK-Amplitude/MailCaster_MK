// CRON_SECRET 검증 공용 헬퍼 — 상수시간 비교 (076 보안 감사 L12 후속)
// 일반 문자열 !== 비교는 조기 종료 timing 채널이 있음. 원격으로는 실용성 낮지만
// track-click 의 서명 비교와 동일한 방식으로 통일한다.

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Authorization 헤더가 `Bearer <CRON_SECRET>` 인지 상수시간으로 확인 */
export function isCronAuthorized(authHeader: string | null, cronSecret: string): boolean {
  if (!cronSecret || !authHeader) return false
  return timingSafeEqualStr(authHeader, `Bearer ${cronSecret}`)
}
