# Outreach 연동 설정 가이드

MailCaster ↔ Outreach 연동을 활성화하려면 Outreach 측 OAuth 앱 등록과 환경변수 설정이 필요합니다.

## 1) Outreach OAuth App 등록

Outreach Admin 으로 로그인해 다음을 수행합니다.

1. **Settings → Integrations → API Access** 진입.
2. **Add → OAuth Application** 클릭.
3. 아래 정보 입력:
   - **Application Name**: `MailCaster`
   - **Redirect URI**: `https://mk-amplitude.github.io/MailCaster_MK/outreach/callback`
     (로컬 개발: `http://localhost:5173/outreach/callback`)
   - **Scopes** (체크):
     - `prospects.read`, `prospects.write`
     - `mailings.read`, `mailings.write`
     - `users.read`, `users.all`
4. 저장 후 발급되는 **Client ID** 와 **Client Secret** 을 안전한 곳에 기록.

## 2) Supabase 환경변수 (Edge Functions)

Supabase Dashboard → Project Settings → Edge Functions → Secrets 에서 추가:

| 키 | 값 |
|---|---|
| `OUTREACH_CLIENT_ID` | 1단계에서 발급된 Client ID |
| `OUTREACH_CLIENT_SECRET` | 1단계에서 발급된 Client Secret |
| `OUTREACH_REDIRECT_URI` | `https://mk-amplitude.github.io/MailCaster_MK/outreach/callback` |

또는 CLI 로:

```bash
npx supabase secrets set \
  OUTREACH_CLIENT_ID=<your-client-id> \
  OUTREACH_CLIENT_SECRET=<your-client-secret> \
  OUTREACH_REDIRECT_URI=https://mk-amplitude.github.io/MailCaster_MK/outreach/callback
```

## 3) Frontend 환경변수 (Vite)

`.env.production` (GitHub Pages 빌드용) 에 추가:

```
VITE_OUTREACH_CLIENT_ID=<your-client-id>
```

GitHub Actions 의 Secrets 에도 동일 키로 등록해 빌드 시 주입.

## 4) 사용자 흐름

1. 사용자가 Settings → "외부 연동 — Outreach" → **Outreach 연결하기** 클릭
2. Outreach 로그인 페이지로 이동, 사용자 동의
3. `/outreach/callback` 로 redirect → 자동으로 토큰 교환 → Settings 로 복귀
4. 이후 발송하는 모든 메일이 자동으로 Outreach prospect activity 에 기록됨

## 5) 동작 방식

- **즉시 발송 (useSendCampaign)**: 캠페인 완료 후 성공한 recipient 들을 fire-and-forget 으로 동기화
- **예약 발송 (cron)**: 각 처리 batch 종료 시 동일 방식으로 동기화
- **중복 방지**: `recipients.outreach_mailing_id` 가 NULL 인 행만 동기화 — 한 번 push 된 메일은 재푸시되지 않음
- **Prospect 매칭**: email 로 lookup → 없으면 자동 create (이름 분리 — 한국식 "성+이름" 단순 split)
- **토큰 갱신**: 만료 10분 전부터 자동 refresh
- **실패 처리**: `recipients.outreach_sync_error` 컬럼에 사유 기록 — Outreach 미연결 사용자는 silently skip

## 6) 수동 백필 (선택)

이미 발송 완료된 과거 메일을 Outreach 로 일괄 동기화하려면:

```bash
# CRON_SECRET 으로 직접 호출 — recipient_ids 를 묶어서
curl -X POST 'https://<project>.supabase.co/functions/v1/outreach-sync-mailing' \
  -H 'Authorization: Bearer <CRON_SECRET>' \
  -H 'Content-Type: application/json' \
  -d '{"recipient_ids":["uuid1","uuid2",...]}'
```

UI 버튼이 필요하면 Settings 의 OutreachSection 에 추가 가능.

## 7) 검증

- Outreach → Prospects → 임의 prospect → Activity 탭에 MailCaster 가 보낸 메일이 mailing 으로 표시되는지 확인
- 매칭이 안 되면 `recipients.outreach_sync_error` 컬럼 확인
- 로그: Supabase Dashboard → Edge Functions → outreach-sync-mailing → Logs
