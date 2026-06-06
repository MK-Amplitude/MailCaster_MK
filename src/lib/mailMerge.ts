// 템플릿 문자열 안의 {{key}} 를 실제 값으로 치환
// 값이 없거나 null 이면 빈 문자열로 대체
export function renderTemplate(
  input: string,
  variables: Record<string, string | null | undefined>
): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = variables[key]
    return v == null ? '' : String(v)
  })
}

// 템플릿 본문에 포함된 변수 키 목록 추출
export function extractVariables(input: string): string[] {
  const set = new Set<string>()
  const re = /\{\{\s*([\w.]+)\s*\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    set.add(m[1])
  }
  return Array.from(set)
}

/**
 * 본문에 시그니처가 이미 포함되어 있는지 plain-text fragment 로 판정.
 * 발송 (useSendCampaign) 과 미리보기 (CampaignDetailPage) 가 같은 정책을 써야
 * "미리보기엔 시그니처 2개, 실제 발송은 1개" 같은 불일치가 안 생김.
 *
 * 정책: 서명의 plain text (태그 제거 + 공백 정규화) fragment 가 본문 plain text 안에 있으면 포함된 것.
 *   - 서명 짧으면 (40자 미만) 전체 정확 포함 요구 — 우연 충돌 회피
 *   - 길면 앞 80자 fragment 매칭 (이름/직책/회사명 등 충돌 가능성 낮은 영역)
 */
export function bodyAlreadyContainsSignature(bodyHtml: string, sigHtml: string): boolean {
  const strip = (h: string) =>
    h
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const bodyPlain = strip(bodyHtml)
  const sigPlain = strip(sigHtml)
  if (!sigPlain) return true
  if (sigPlain.length < 40) return bodyPlain.includes(sigPlain)
  const fragment = sigPlain.slice(0, 80)
  return bodyPlain.includes(fragment)
}
