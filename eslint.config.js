// ============================================================
// eslint.config.js (ESLint 9 flat config)
// ------------------------------------------------------------
// React 19 + TypeScript + Vite 프로젝트의 린트 설정.
//
// 범위:
//   - src/**/*.{ts,tsx} : 앱 소스
//   - supabase/functions/**/*.ts : Edge Function (Deno 환경)
//
// 제외:
//   - dist, node_modules, supabase/migrations (SQL), *.d.ts
//
// 규칙 기조:
//   - typescript-eslint 의 recommended 를 기본 베이스
//   - react-hooks 의 recommended — Hook 사용 규칙 + 의존성 배열
//   - react-refresh — Fast Refresh 경계 유지
//   - 기존 코드베이스에 사용 중인 `// eslint-disable-next-line` 주석들과
//     충돌하지 않도록 규칙명(@typescript-eslint/no-explicit-any,
//     react-hooks/exhaustive-deps, no-constant-condition, no-control-regex)
//     을 그대로 유지.
// ============================================================

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // -----------------------------------------------------------
  // 린트 대상 외
  // -----------------------------------------------------------
  {
    ignores: [
      'dist',
      'node_modules',
      'supabase/migrations',
      '**/*.d.ts',
      // 빌드 결과 / 생성물
      'coverage',
      '.vite',
    ],
  },

  // -----------------------------------------------------------
  // 앱 소스 (브라우저)
  // -----------------------------------------------------------
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // 미사용 변수 — `_` 로 시작하면 허용 (destructuring 에서 앞쪽만 쓸 때).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // -----------------------------------------------------------
  // vite.config / eslint.config 등 Node 환경 파일
  // -----------------------------------------------------------
  {
    files: ['*.config.{js,ts}', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // -----------------------------------------------------------
  // Supabase Edge Functions — Deno 런타임.
  // (브라우저 / Node 와 겹치는 API 가 많아 lint 는 느슨하게)
  // -----------------------------------------------------------
  {
    files: ['supabase/functions/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Deno 전역 — 타입은 있지만 lint 로 검증은 안 함
        Deno: 'readonly',
        ...globals.browser,
      },
    },
    rules: {
      // Edge function 은 외부 URL import 가 많아 import 규칙을 완화
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
)
