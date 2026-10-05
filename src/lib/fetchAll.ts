// PostgREST 는 서버 설정 max_rows(Supabase 기본 1000)로 응답 행 수를 강제로 자른다.
// .range(0, 9999) 를 줘도 1000행에서 조용히 잘리므로, 목록 쿼리는 페이지 단위로 끝까지 읽는다.
//
// 사용 규칙:
//   - build(from, to) 는 매 호출마다 새 쿼리를 만들어 .range(from, to) 까지 붙여 반환해야 한다.
//   - 반드시 고유 컬럼(id 등)으로 .order() 를 걸 것 — 정렬이 없으면 페이지 사이에서
//     행이 중복/누락될 수 있다.
//   - 빈 페이지가 나올 때까지 계속 읽는다 (C-7). "짧은 페이지 = 마지막" 으로 판정하면
//     프로젝트 max_rows 가 pageSize 보다 작을 때(예: 500) 첫 페이지가 짧게 와서 조용히 잘린다.
//     다음 offset 은 요청한 pageSize 가 아니라 실제로 받은 행 수만큼 전진한다 — max_rows 가
//     더 작아도 행을 건너뛰지 않는다. 마지막 페이지 뒤에 빈 응답 1회가 추가로 나간다.

export const FETCH_PAGE_SIZE = 1000

// 무한 루프 방지용 상한 — 요청 횟수 기준 (페이지가 max_rows 로 짧아져도 충분하도록 넉넉히)
const MAX_PAGES = 2000
// 결과 행 수 상한 (50만 행)
const MAX_ROWS = 500_000

// data 는 unknown 으로 받는다 — embed(select 'x!inner(...)') 쿼리의 생성 타입이 실제 응답 모양과
// 다른 경우가 많아, 행 타입은 호출자가 T 로 지정한다.
type PageResult = { data: unknown; error: unknown }

export async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<PageResult>,
  pageSize: number = FETCH_PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    if (rows.length === 0) return out
    // 반복문으로 push — spread(push(...rows)) 는 아주 큰 페이지에서 인자 수 한도에 걸릴 수 있다.
    for (const r of rows) out.push(r)
    if (out.length > MAX_ROWS) break
    from += rows.length
  }
  throw new Error(`목록이 너무 큽니다 (${out.length}행 이상 — 페이지 ${MAX_PAGES}회 / ${MAX_ROWS}행 한도).`)
}

/** `.in('id', ids)` 처럼 값 목록을 URL 에 싣는 쿼리를 나눠 보낼 때 사용 (URL 길이 한도 회피). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// UUID 36자 + 구분자 — 200개면 쿼리스트링 ~7.5KB 로 프록시/서버 URL 한도(보통 8–16KB) 안쪽.
export const IN_FILTER_CHUNK = 200
