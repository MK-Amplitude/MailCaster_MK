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
