// Google OAuth 토큰 암호화/복호화 유틸 (AES-256-GCM, Web Crypto API)
//
// 목적: DB 에 저장되는 google_refresh_token / google_access_token 을 암호화해
//       DB 덤프·백업 유출 시에도 토큰을 직접 사용할 수 없도록 보호.
//
// 키 관리: Supabase Edge Function secret 'TOKEN_ENCRYPTION_KEY' (base64url, 32 bytes)
//   - 생성: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
//   - 등록: supabase secrets set TOKEN_ENCRYPTION_KEY=<값>
//
// 형식: "v1:<base64url(iv 12B)>.<base64url(ciphertext+tag)>"
//   - v1 prefix 로 향후 알고리즘 교체 시 버전 구분 가능.
//   - 암호화되지 않은 기존 값은 "v1:" 로 시작하지 않으므로 판별 후 평문 반환 (하위 호환).

const KEY_ENV = 'TOKEN_ENCRYPTION_KEY'

let _cachedKey: CryptoKey | null = null

async function getKey(): Promise<CryptoKey | null> {
  if (_cachedKey) return _cachedKey
  const raw = Deno.env.get(KEY_ENV)
  if (!raw) return null
  try {
    const keyBytes = base64urlDecode(raw)
    _cachedKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    return _cachedKey
  } catch (e) {
    console.error('[tokenCrypto] key import failed:', e)
    return null
  }
}

export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getKey()
  if (!key) {
    // 키 없으면 평문 저장 (환경 변수 미설정 시 기존 동작 유지, 경고만 출력)
    console.warn('[tokenCrypto] TOKEN_ENCRYPTION_KEY not set — storing token in plaintext')
    return plaintext
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  return `v1:${base64urlEncode(iv)}.${base64urlEncode(new Uint8Array(cipherBuffer))}`
}

export async function decryptToken(stored: string): Promise<string> {
  if (!stored.startsWith('v1:')) {
    // 암호화 이전에 저장된 평문 토큰 — 그대로 반환 (하위 호환)
    return stored
  }
  const key = await getKey()
  if (!key) {
    console.error('[tokenCrypto] TOKEN_ENCRYPTION_KEY not set — cannot decrypt token')
    throw new Error('TOKEN_ENCRYPTION_KEY 가 설정되지 않아 토큰을 복호화할 수 없습니다.')
  }
  const body = stored.slice('v1:'.length)
  const dotIdx = body.indexOf('.')
  if (dotIdx < 0) throw new Error('잘못된 암호화 토큰 형식')
  const iv = base64urlDecode(body.slice(0, dotIdx))
  const cipherBytes = base64urlDecode(body.slice(dotIdx + 1))
  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes)
  return new TextDecoder().decode(plainBuffer)
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
