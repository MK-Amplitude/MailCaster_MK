import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database.types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase 환경변수가 설정되지 않았습니다. .env.local 파일을 확인하세요.')
}

export const supabase = createClient<Database, 'mailcaster'>(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    // 공유 Supabase 프로젝트에서 다른 앱의 세션과 충돌 방지
    storageKey: 'mailcaster-auth',
    // React Strict Mode 에서 내부 lock 이 풀리지 않아 요청이 영구 대기하는 버그 회피
    lock: async <R,>(_name: string, _acquireTimeout: number, fn: () => Promise<R>) => fn(),
  },
  db: {
    schema: 'mailcaster',
  },
})
