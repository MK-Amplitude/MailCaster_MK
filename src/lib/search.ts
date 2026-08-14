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

// 단일 엔트리 쿼리 캐시 — matchesSearch 는 목록 필터에서 같은 query 로
// 수만 번 연속 호출되므로 (10k 연락처 × 5 필드/keystroke), query 의
// toLowerCase / 초성 판정을 호출마다 반복하지 않도록 마지막 결과를 기억.
let _cachedQuery = ''
let _cachedLower = ''
let _cachedIsChoseong = false

function prepareQuery(query: string): void {
  if (query === _cachedQuery) return
  _cachedQuery = query
  _cachedLower = query.toLowerCase()
  _cachedIsChoseong = isChoseongQuery(query)
}

/**
 * text 안에 query 가 포함되는지 검사.
 * 일반 부분일치(대소문자 무시) + query 가 초성-only 일 때 초성 부분일치까지 허용.
 */
export function matchesSearch(text: string | null | undefined, query: string): boolean {
  if (!query) return true
  if (!text) return false
  prepareQuery(query)
  const t = text.toLowerCase()
  if (t.includes(_cachedLower)) return true
  if (_cachedIsChoseong) {
    return toChoseong(text).includes(query)
  }
  return false
}
