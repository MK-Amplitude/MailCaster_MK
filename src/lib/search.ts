// 한글 초성 검색 유틸
// 한글 음절 범위: 0xAC00(가) ~ 0xD7A3(힣)
// 각 음절 = 초성(19) × 중성(21) × 종성(28)
const CHOSEONG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
]

/** 문자열을 초성 문자열로 변환. 한글이 아니면 원문 유지. */
export function toChoseong(str: string): string {
  let out = ''
  for (const ch of str) {
    const code = ch.charCodeAt(0)
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = Math.floor((code - 0xac00) / (21 * 28))
      out += CHOSEONG[idx]
    } else {
      out += ch
    }
  }
  return out
}

/** query가 초성(ㄱ-ㅎ)과 공백으로만 이루어져 있는지 */
function isChoseongQuery(q: string): boolean {
  return /^[\u3131-\u314e\s]+$/.test(q)
}

/**
 * text 안에 query 가 포함되는지 검사.
 * 일반 부분일치(대소문자 무시) + query 가 초성-only 일 때 초성 부분일치까지 허용.
 */
export function matchesSearch(text: string | null | undefined, query: string): boolean {
  if (!query) return true
  if (!text) return false
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (t.includes(q)) return true
  if (isChoseongQuery(query)) {
    return toChoseong(text).includes(query)
  }
  return false
}
