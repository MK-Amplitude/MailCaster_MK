# MailCaster

Gmail 기반 개인화 대량 메일 발송 서비스. React + Vite + TypeScript + Supabase.

---

## 개발 환경 셋업

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경변수 설정
```bash
cp .env.example .env.local
# .env.local 을 열어 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 입력
```
값 확인 위치: Supabase Dashboard → 프로젝트 선택 → **Settings → API**

### 3. DB 마이그레이션
`supabase/migrations/` 안의 SQL 파일들을 번호 순으로 Supabase SQL Editor 에서 실행.

### 4. 로컬 실행
```bash
npm run dev        # http://localhost:5173
npm run build      # 프로덕션 번들 (dist/)
npm run preview    # 빌드 결과 로컬 미리보기
npm run lint       # ESLint
```

---

## Lovable 배포 가이드 (모바일 접근 포함)

MailCaster 는 React SPA 로, 배포만 하면 모바일 브라우저에서도 바로 사용 가능합니다.
홈 화면에 "앱처럼 추가" 하려면 PWA manifest 가 자동 적용됩니다.

### A. Lovable 프로젝트 연결

1. https://lovable.dev 로그인 (GitHub 연동)
2. **New Project → Import from GitHub** → `MK-Amplitude/MailCaster_MK` 선택
3. Framework 자동 감지(`Vite`) 확인
4. **Project Settings → Environment Variables** 탭:
   | Key | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `.env.local` 값 그대로 |
   | `VITE_SUPABASE_ANON_KEY` | `.env.local` 값 그대로 |
5. **Deploy** — 빌드 2~3분 소요. 완료 후 URL 확인 (예: `https://mailcaster-mk.lovable.app`)

### B. Supabase Auth URL Configuration

배포 후, Lovable 도메인을 Supabase Auth 허용 목록에 추가해야 Google 로그인이 동작합니다.

1. Supabase Dashboard → **Authentication → URL Configuration**
2. **Site URL**: `https://mailcaster-mk.lovable.app` (로컬 개발용 `localhost` 값은 여기서 덮어써짐 — 로컬은 Redirect URLs 로 대응)
3. **Redirect URLs** (Add URL):
   ```
   http://localhost:5173/**
   https://mailcaster-mk.lovable.app/**
   ```
4. Save

### C. Google Cloud Console OAuth Client

1. https://console.cloud.google.com → **APIs & Services → Credentials**
2. 기존 **OAuth 2.0 Client ID** 편집
3. **Authorized JavaScript origins** 에 추가 (리디렉션 URI 는 변경 불필요):
   ```
   https://mailcaster-mk.lovable.app
   ```
4. Save — 반영까지 최대 5분

### D. 모바일 동작 확인

1. 스마트폰 브라우저로 배포 URL 접속
2. Google 로그인 → 각 페이지 렌더링 확인
3. **홈 화면 추가**:
   - iOS Safari: 공유 버튼 → "홈 화면에 추가"
   - Android Chrome: 메뉴 → "앱 설치" 또는 "홈 화면에 추가"
4. 홈 아이콘 탭 → 주소창 없이 앱처럼 열리면 PWA 동작 정상

---

## 프로젝트 구조

```
src/
├── pages/              — 라우트 페이지 (Login / Dashboard / Contacts / Groups / ...)
├── components/
│   ├── ui/            — shadcn/ui 원시 컴포넌트
│   ├── layout/        — Sidebar, Topbar, AppLayout
│   ├── common/        — EmptyState, ConfirmDialog, BulkActionBar 등 공용
│   ├── contacts/      — 연락처 관리 전용
│   ├── groups/        — 그룹/카테고리 관리
│   ├── signatures/    — 서명 에디터 (TipTap)
│   ├── templates/     — 템플릿 에디터
│   ├── campaigns/     — 캠페인 위저드/상세
│   └── attachments/   — Drive 첨부
├── hooks/              — TanStack Query 기반 데이터 훅 (useContacts 등)
├── contexts/           — AuthContext
├── lib/                — supabase 클라이언트, utils
└── types/              — TypeScript 인터페이스

supabase/
├── migrations/         — 순차 SQL 마이그레이션
└── functions/          — Edge Functions (Gmail 발송, cron, track-open 등)
```

---

## 빌드 청크 전략

`vite.config.ts` 의 `manualChunks` 로 도메인별 분리:

| 청크 | 내용 | 로딩 시점 |
|---|---|---|
| `vendor-tiptap` | TipTap + ProseMirror | 서명/템플릿/캠페인 진입 시 |
| `vendor-parsers` | xlsx + papaparse | 연락처 import 시 |
| `vendor-charts` | recharts + d3 | 대시보드 진입 시 |
| `vendor-data` | Supabase + TanStack Query | 전 페이지 |
| `vendor-ui` | Radix + lucide | 전 페이지 |
| `vendor` | React 외 catch-all | 전 페이지 |

초기 로드 시 필수 청크만 내려받아 모바일에서도 빠른 시작.

---

## 보안 / 정합성 체크리스트

- [x] Supabase RLS — 모든 테이블에 `user_id = auth.uid()` 정책
- [x] Google 토큰은 `profiles` 테이블에만, UI 에서는 수정 불가 (타입에서 제외)
- [x] anon key 노출 안전 — RLS 로 보호
- [ ] service_role key 는 Edge Functions 환경변수로만 (절대 커밋 금지)
- [x] 수신거부 목록은 발송 경로에서 자동 제외
- [x] 일일 발송 한도 (`daily_send_limit`) 체크

---

## 흔한 함정

| 증상 | 원인 | 해결 |
|---|---|---|
| 배포 후 로그인 시 "redirect_uri_mismatch" | GCP 에 Lovable 도메인 안 넣음 | C 섹션 재확인 |
| 로그인은 되지만 빈 화면 | Env var 누락 | Lovable → Environment Variables 재확인 |
| iOS 홈 아이콘이 흐림 | SVG 를 apple-touch-icon 으로 사용 | 필요 시 `npx pwa-asset-generator public/apple-touch-icon.svg public/ --type png` 로 PNG 생성 |
| 모바일 홈바에 버튼 가림 | safe-area CSS 누락 | `.pb-safe` / `.bottom-6-safe` 유틸 적용 확인 (`src/index.css`) |
| Gmail scope 프로덕션 검증 필요 | Google 민감 scope 정책 | 개발 중엔 OAuth consent screen 의 Test Users 등록으로 우회 |

---

## PWA 아이콘 품질 개선 (선택)

현재는 SVG 아이콘 하나로 favicon/manifest/iOS 아이콘 전부 처리. iOS 구형 기기에서
홈 화면 아이콘이 흐릿하면 PNG 를 생성해 추가:

```bash
# Node 18+ 필요, 설치 없이 실행
npx pwa-asset-generator public/apple-touch-icon.svg public/ \
  --background "#2563EB" \
  --type png \
  --icon-only \
  --padding "0"
```

생성된 PNG 들을 `index.html` 과 `manifest.webmanifest` 에 등록.
