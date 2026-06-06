// 그룹사 (parent_group) 표기 유사도 판정.
// "현대백화점" / "현대 백화점" / "현대백화점주식회사" 같은 미세 차이를 통합 제안하기 위함.
//
// 사용처:
//   - ContactFormDialog / ContactDetailSheet 그룹사 입력 시 비슷한 기존 그룹사 추천
//   - "새 그룹사로 등록할지, 기존 [현대백화점] 으로 통일할지" 안내
//
// 디자인:
//   1. 정규화 (whitespace 제거 + 소문자 + 한글 정규화) 후 substring / 편집거리 비교
//   2. threshold 이상의 후보 N개 반환

/** 비교용 정규화 — 공백 제거, 소문자, 흔한 접미사 제거 */
export function normalizeCompanyName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(
      /(주식회사|㈜|\(주\)|inc\.?|incorporated|corp\.?|corporation|co\.?,?ltd\.?|ltd\.?|llc|limited)$/i,
      '',
    )
    .trim()
}

/** Levenshtein 편집거리 (단순 구현 — N < 50 이므로 O(N*M) OK). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // delete
        dp[i][j - 1] + 1, // insert
        dp[i - 1][j - 1] + cost, // substitute
      )
    }
  }
  return dp[a.length][b.length]
}

/** 0~1 유사도 (1 = 동일) */
export function similarity(a: string, b: string): number {
  const na = normalizeCompanyName(a)
  const nb = normalizeCompanyName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  // substring 관계 (예: "현대백화점" ⊂ "현대백화점주식회사") 는 강한 신호
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length)
    const longer = Math.max(na.length, nb.length)
    return Math.max(0.85, shorter / longer)
  }
  const maxLen = Math.max(na.length, nb.length)
  if (maxLen === 0) return 0
  return 1 - editDistance(na, nb) / maxLen
}

/**
 * 입력값과 비슷한 기존 그룹사 후보를 찾아서 반환.
 * threshold 이상 + 동일한 normalized 가 아닌 경우만.
 *
 * @param input 사용자가 입력한 새 값
 * @param existing 기존 parent_group 리스트
 * @param threshold 0~1, 기본 0.7
 * @param limit 최대 후보 수
 */
export function findSimilarGroups(
  input: string,
  existing: string[],
  threshold = 0.7,
  limit = 5,
): Array<{ name: string; score: number }> {
  if (!input.trim()) return []
  const inputNorm = normalizeCompanyName(input)
  if (!inputNorm) return []
  const scored: Array<{ name: string; score: number }> = []
  for (const cand of existing) {
    if (cand === input) continue // 정확 일치는 제외 (이미 같은 거니까)
    const candNorm = normalizeCompanyName(cand)
    if (!candNorm) continue // 후보가 정규화 후 빈 문자열 (예: "(주)") — 비교 불가, skip
    if (candNorm === inputNorm) {
      // 정규화 후 동일 = 표기만 다른 케이스 — 가장 강력한 신호
      scored.push({ name: cand, score: 1 })
      continue
    }
    const s = similarity(input, cand)
    if (s >= threshold) scored.push({ name: cand, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
