# MailCaster MK — Claude Code 세션 가이드

## 프로젝트 개요

한국 B2B 영업팀을 위한 Gmail 기반 개인화 메일링 도구.

**스택**
- **프론트엔드**: React 19 + TypeScript + Vite + TanStack Query v5 + shadcn/ui + Tailwind CSS
- **백엔드**: Supabase — Postgres + Edge Functions (Deno) + Auth + RLS + pg_cron
- **호스팅**: GitHub Pages (`https://mk-amplitude.github.io/MailCaster_MK/`)

---

## 배포 — 절대 규칙

배포는 **GitHub Actions 자동 실행**. 세션에서 직접 실행하지 말 것.

| 대상 | 워크플로 | 트리거 |
|------|----------|--------|
| 프론트엔드 | `.github/workflows/deploy.yml` | `main` push |
| DB 마이그레이션 + Edge Functions | `.github/workflows/supabase-deploy.yml` | `main` push (supabase/** 변경 시) |

**금지 사항**
- `supabase db push` 직접 실행 금지 (클라우드 자격증명 없음)
- `supabase functions deploy` 직접 실행 금지
- 시크릿·비밀번호를 코드나 커밋에 절대 포함 금지

---

## 작업 규칙

1. **`main` 직접 push 금지** — 반드시 feature 브랜치 생성 후 PR
2. 변경 후 반드시 아래 명령으로 검증:
   ```bash
   npm run lint && npm run build && npx vitest run
   ```
3. 커밋 메시지 끝에 `Co-Authored-By` 트레일러 유지

---

## DB 컨벤션

### 스키마
모든 테이블은 `mailcaster` 스키마에 위치.

### RLS
org 기반 스코프 — `user_org_ids()` 함수로 현재 사용자의 org 목록 조회 후 필터링.

### RPC
SECURITY DEFINER + `SET search_path = mailcaster, public` 고정 필수.

### 마이그레이션
- 위치: `supabase/migrations/`
- 파일명 규칙: `NNN_description.sql` (3자리 순번)
- **현재 최신 마이그레이션: `068_sequence_step_funnel.sql`**
- 신규 마이그레이션 파일명은 `069_` 부터 시작

---

## 핵심 도메인

| 도메인 | 설명 |
|--------|------|
| `campaigns` | 그룹 대상 대량 발송. `campaign_kind` 로 일반/예약 구분. 수신자별 개인화 override 지원 |
| `contacts` | 연락처 + 그룹(카테고리) + AI 기반 그룹 추천. Google Contacts 동기화 |
| `thread_messages` | 1:1 메일 스레드 (followup / reply / forward / new). 오픈 트래킹 포함 |
| `inbound_messages` | 받은 메일 인박스. `check-inbox` Edge Function 이 pg_cron 으로 폴링 |
| `sequences` | 자동 후속 발송 cadence. `process-sequences` Edge Function 이 pg_cron 으로 실행 |
| `analytics` | 퍼널·세그먼트·스텝 전환 집계. `analytics_rpcs` (migration 066) 로 집계 RPC 제공 |

---

## 디렉터리 구조

```
src/
├── components/
│   ├── campaigns/      # 캠페인 발송·분석 UI
│   ├── contacts/       # 연락처 관리
│   ├── engagement/     # 인게이지먼트 차트·타임라인
│   ├── groups/         # 그룹·카테고리
│   ├── layout/         # AppLayout, Sidebar, OrgSwitcher
│   ├── settings/       # 조직 설정
│   ├── signatures/     # 서명 (TipTap 에디터)
│   ├── templates/      # 메일 템플릿
│   ├── common/         # 공통 컴포넌트
│   └── ui/             # shadcn/ui 기본 컴포넌트
├── hooks/              # TanStack Query 기반 데이터 훅 (35+)
├── lib/
│   ├── supabase.ts     # Supabase 클라이언트
│   ├── gmail.ts        # Gmail API
│   ├── drive.ts        # Google Drive API
│   ├── googleToken.ts  # OAuth 토큰 관리
│   └── mailMerge.ts    # 메일 머지 로직 (vitest 커버)
├── pages/              # 라우트 페이지 (17개)
└── types/              # TypeScript 인터페이스

supabase/
├── migrations/         # 001_~068_ SQL 마이그레이션 (순번 관리)
├── functions/          # 16개 Deno Edge Functions
│   ├── check-inbox/        # pg_cron: 인박스 폴링
│   ├── check-replies/      # pg_cron: 답장 감지
│   ├── process-sequences/  # pg_cron: 시퀀스 자동 발송
│   ├── send-scheduled-campaigns/ # pg_cron: 예약 발송
│   ├── track-open/         # 픽셀 오픈 트래킹 (verify_jwt=false)
│   ├── resolve-company/    # 회사 정보 해석
│   └── ...
└── config.toml         # Edge Function JWT 설정

.github/workflows/
├── deploy.yml          # GitHub Pages 배포
└── supabase-deploy.yml # DB 마이그레이션 + 함수 배포
```

---

## 로컬 개발

```bash
npm install
npm run dev          # Vite dev server
npm run lint         # ESLint
npm run build        # tsc + Vite build
npx vitest run       # 단위 테스트
```

환경 변수 (`.env.local`):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

---

## Edge Function 주의 사항

`config.toml` 에서 `verify_jwt = false` 로 설정된 함수는 pg_cron 또는 픽셀 요청 등
JWT 없이 호출되는 경우. 이 함수들은 내부적으로 `CRON_SECRET` 헤더나 서비스 롤 키로
자체 인증 처리.
