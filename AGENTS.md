# MailCaster MK — AI 코딩 도구 공통 가이드 (Cursor / Codex / Claude Code)

> **정본은 [`CLAUDE.md`](./CLAUDE.md) 입니다.** 프로젝트 개요·스택·DB 컨벤션·
> 디렉터리 구조·핵심 도메인은 그 파일을 먼저 읽으세요. 이 파일은 어떤 AI 도구를
> 쓰든 반드시 지켜야 하는 최소 규칙의 요약입니다.

## 절대 규칙

1. **`main` 직접 push 금지** — feature 브랜치 → PR → 머지.
2. **배포는 GitHub Actions 자동**: `main` push 시 `deploy.yml`(GitHub Pages),
   `supabase/**` 변경 시 `supabase-deploy.yml`(마이그레이션+Edge Functions).
   로컬에서 `supabase db push` / `supabase functions deploy` 직접 실행 금지.
3. 시크릿·비밀번호를 코드/커밋에 절대 포함 금지.
4. 변경 후 검증 필수: `npm run lint && npm run build && npx vitest run`
5. 마이그레이션은 `supabase/migrations/NNN_...sql` 3자리 순번 —
   **디렉터리의 실제 최신 순번을 확인 후 +1** (CLAUDE.md 의 숫자는 참고용).

## 로컬 셋업 (새 환경에서 이어서 작업하기)

```bash
git clone https://github.com/MK-Amplitude/MailCaster_MK.git
cd MailCaster_MK
npm ci
# .env.local 생성 — 값은 Supabase Dashboard → Settings → API 에서 복사
#   VITE_SUPABASE_URL=...
#   VITE_SUPABASE_ANON_KEY=...
npm run dev
```

## git 에 없는 것 (별도 보관 필요)

- `.env.local` (Supabase URL + anon key) — Supabase Dashboard 에서 재발급 가능
- GitHub Actions 시크릿 — repo Settings → Secrets (SUPABASE_ACCESS_TOKEN,
  SUPABASE_DB_PASSWORD, VITE_*)
- Edge Function 시크릿 — Supabase Dashboard → Edge Functions → Secrets
  (CRON_SECRET, GOOGLE_CLIENT_ID/SECRET, OPENAI_API_KEY, TOKEN_ENCRYPTION_KEY,
  CLICK_SIGNING_SECRET)
- **DB 데이터** (연락처·캠페인 등) — 스키마는 마이그레이션으로 재현되지만
  데이터는 아님. 백업: `supabase db dump --data-only -f backup.sql`
