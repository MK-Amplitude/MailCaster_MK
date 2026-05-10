// vitest 설정 — vite.config 과 분리해 단순함 유지.
// path alias '@' 만 vite 와 동일하게 맞추고, 그 외는 vitest 기본값 사용.

import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
