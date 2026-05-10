# Code Review — MailCaster_MK

> 2026-05-09 기준. 전체 ~13.8K LOC / 114 TS·TSX 파일. `npm run build` ✅ / `npm run lint` ✅ (0 errors, 0 warnings).

## 1. 전체 평가

견고한 React + Supabase 구조. shadcn/ui · TanStack Query · React Router 표준 패턴. 보안·기본 UX는 양호. **확장성과 유지보수성**이 다음 단계 과제.

---

## 2. 강점

| 영역 | 내용 |
|---|---|
| **보안** | `dangerouslySetInnerHTML` 없음. 하드코딩된 시크릿 없음. Edge function 들이 자체 auth 검증. RLS 정책이 모든 mutable 테이블에 적용됨 (migration 015). |
| **데이터 모델** | 잘 정규화됨. 18~26번 migration 만 봐도 점진적·역호환 변경. Phase별 정리 주석 유용. |
| **타입** | 자동 생성된 `database.types.ts` 사용. View 도 타입화. |
| **문서** | 마이그레이션·hook·edge function 마다 한국어 주석으로 의도/이유 풍부. 새 사람이 들어와도 빠르게 따라잡을 수 있음. |
| **에러 메시지** | "오프라인 영업 보조" 도메인에 맞게 한국어 친화 메시지로 일관. |
| **shadcn 채택** | 일관된 디자인 시스템. 대부분 변경 없이 사용 → 업스트림과 동기화 쉬움. |

---

## 3. 우선순위 높은 이슈 (P0–P1)

### P0. CampaignWizardPage가 2,640 LOC

```
src/pages/CampaignWizardPage.tsx   2,640
src/pages/CampaignDetailPage.tsx   1,017
src/hooks/useSendCampaign.ts         815
```

- CampaignWizardPage에 `useState` 34개. Step1/Step2/Step3가 같은 파일 내부 함수.
- 한 파일 안에 wizard, schedule UI, variable picker, recipient basket 로직 다 섞임.
- **권장**: `src/pages/campaign-wizard/{Step1,Step2,Step3,Schedule,VariableDropdown}.tsx` 로 분할. 공통 state는 Context 또는 reducer 로 끌어올리고, 각 Step 은 props 로만 받기. 1,500 LOC 정도는 줄어들 것.

### P0. 테스트 0건

- `*.test.*` 파일 없음. vitest 설정 없음.
- 발송·수신추적·Gmail OAuth 같은 **돌이킬 수 없는 동작**이 많은 도메인. 회귀가 비싸짐.
- **권장 최소**:
  1. `src/lib/insights.ts` — 순수 함수, 테스트하기 가장 쉬움. 인사이트 detection ↔ filter 일치 회귀 방지.
  2. `src/lib/mailMerge.ts` — 변수 치환 회귀 방지.
  3. `useSendCampaign` — 모킹된 Gmail으로 happy path 1개.
  - vitest + msw 기준 1일 작업.

### P1. 클라이언트 사이드 풀-페치 (`.range(0, 9999)`)

- 모든 주요 hook 이 9,999 행을 한 번에 받아 클라에서 필터/정렬.
- 현재 ~1K 연락처 / ~수십 캠페인이면 OK. **5K 넘어가면 체감 느려짐**.
- **단계적 권장**:
  - 1차: 서버 사이드 필터 추가 (`customer_type`, `parent_group` 필터를 Supabase 쿼리로 푸시다운)
  - 2차: 페이지네이션 / 무한 스크롤 — TanStack Query의 `useInfiniteQuery`
  - 3차: 인덱스 최적화 (이미 일부 있음 — `idx_contacts_customer_type` 등)

### P1. CampaignDetailPage 1,017 LOC

- 발송 결과 / 미발송 재시도 / 답장 / 첨부 등 각 섹션이 한 파일에.
- **권장**: 섹션별 컴포넌트 분리 + 페이지는 thin shell.

---

## 4. 중간 우선순위 (P2)

### P2.1 `useSendCampaign.ts` 815 LOC

- Gmail API 호출, 발송 큐, 오류 분류, 토큰 리프레시, 진행 상태 머신 다 섞임.
- **권장 분리**:
  - `lib/gmail/send.ts` — Gmail API 래퍼 (이미 일부 `lib/gmail.ts` 에 있음)
  - `lib/gmail/auth.ts` — 토큰 리프레시
  - `hooks/useSendCampaign.ts` — 오케스트레이션만

### P2.2 ~120 console.* 호출

- 디버깅 흔적이 production 번들에 그대로. 약 5–10KB 부풀어 있을 것.
- **권장**: `lib/log.ts` 헬퍼 — `import.meta.env.DEV` 일 때만 출력. 또는 Vite의 `esbuild.drop: ['console', 'debugger']` 빌드 옵션.

### P2.3 입력 검증 (zod 등)

- 14곳에서만 검증. Edge function 의 `body: RequestInput` 같은 곳은 타입 단언만 — 잘못된 입력 시 NPE 위험.
- **권장**: edge function 입력에 zod schema. 친화 에러 응답 자동화. ~1일 작업.

### P2.4 Error Boundary 부재

- React `<ErrorBoundary>` 없음. 한 컴포넌트가 throw 하면 흰 화면.
- **권장**: 최상위 `ErrorBoundary` + 페이지별 fallback. `react-error-boundary` 패키지가 표준.

### P2.5 모바일 a11y

- aria-label / role 사용 21곳 — 작은 편.
- 일부 클릭 가능한 div / button 들 (예: PersonRow) 에 키보드 네비게이션 부재 (Enter / Space).
- **방금 처리한 Sheet safe-area** ✅ — 추가로 Dialog/AlertDialog 도 같은 방식 검토 필요.

### P2.6 Bundle 사이즈

```
vendor (React/Router) 562KB gzipped 182KB
parsers              352KB gzipped 121KB
charts (recharts)    330KB gzipped  90KB
tiptap               317KB gzipped  95KB
```

- **단기**: dynamic import 로 무거운 페이지 지연 로딩. CampaignWizardPage / SettingsPage (TipTap 사용) 가 첫 페이지 로드에 안 들어가게.
- **중기**: parsers 가 무엇인지 확인 — XLSX/CSV import 가 본문에 같이 묶여 있다면 dynamic import 후보.

---

## 5. 낮은 우선순위 (P3)

- `as any` 캐스트 약 5개 (`CampaignWizardPage`, hooks). 대부분 Supabase generated type 의 한계 때문이라 무리한 강제 타입화는 비효율. 다음 db 타입 재생성 때 자연스럽게 줄어듦.
- 일부 한글 주석에 변수명 / 영문 키워드 혼재 — 문제 없지만 검색 시 가끔 놓침.
- `public/manifest.webmanifest` — 아이콘 사이즈가 SVG 한 개. 일부 안드로이드에서 192×192 PNG 가 필요. README 에 이미 메모됨.

---

## 6. 데이터·DB 측면

### 좋음
- Migration 027번 가까이까지 이력이 잘 남아 있음. 각 변경의 "왜?" 가 명시.
- View(`contact_engagement`, `campaign_engagement`) 가 클라 집계 부담을 줄임.
- `security_invoker = true` 로 RLS 일관성 유지.

### 검토할 만한 것
- `contact_engagement` 의 `last_campaign` JSONB subquery — 연락처 수만큼 N+1 비슷한 비용. 1만 명 넘으면 view 자체가 느려질 수 있음.
  - 대안: lateral join + LIMIT 1, 또는 별도 materialized view + cron 새로고침.
- `recipients` 테이블 인덱스: `(contact_id, status, sent_at DESC)` 가 있는지 확인 권장 — `useContactSendHistory` 가 이걸로 정렬.

---

## 7. 즉시 적용 가능한 작은 개선 후보 (안전, 낮은 위험)

| 개선 | 영향 | 시간 |
|---|---|---|
| `vite.config.ts` 에 `esbuild.drop: ['console']` 추가 (production 만) | 번들 ↓, 정보 노출 ↓ | 5분 |
| `<ErrorBoundary>` 최상위 추가 | UX 안정성 | 30분 |
| Recipients 인덱스 확인 + 필요 시 추가 | 답장/오픈 조회 속도 | 15분 |
| README / `docs/` 에 디렉토리 구조 한 장 도식화 | 신규 합류자 onboarding | 30분 |
| 아이콘 192/512 PNG 추가 | 안드로이드 PWA 설치 품질 | 30분 |

---

## 8. 결론

지금 단계: **MVP가 검증 단계로 잘 넘어왔고, 다음은 "스케일과 유지보수"**.

- **즉시(이번 주)**: ErrorBoundary, console drop, 인사이트 모듈 테스트.
- **단기(2주)**: CampaignWizardPage 분할, 핵심 함수 unit test, edge function zod 검증.
- **중기(1–2개월)**: 페이지네이션 본격 도입, lazy loading, materialized view 검토.

위 항목 중 어느 거부터 가실지 정해주시면 바로 들어갑니다.
