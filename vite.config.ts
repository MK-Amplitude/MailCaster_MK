import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// ------------------------------------------------------------
// vite.config.ts
// ------------------------------------------------------------
// 코드 스플리팅:
//   단일 번들이 2 MB 를 넘어가 초기 로드가 느려지는 문제를 해결하기 위해
//   무거운 dependencies 를 도메인별로 분리한다.
//
// 청크 선정 기준:
//   - 페이지 전환 시 재사용도가 높고 / 처음 로드와 무관한 기능들 (xlsx,
//     recharts 같은 "가끔 쓰는" 것들) 을 별도 청크로.
//   - TipTap 처럼 한 페이지에만 쓰이는 거대한 라이브러리는 별도 청크로
//     분리해 "서명/템플릿" 들어가기 전엔 안 내려받도록.
//   - Radix / lucide 는 거의 모든 페이지가 쓰므로 UI 청크 하나로.
//
// React 를 별도 청크로 분리하지 않는 이유:
//   - React 는 모든 페이지에서 사용되므로 초기 로드에 반드시 필요.
//   - 작은 react-shim 패키지들 (react-is, scheduler, object-assign 등)
//     이 다른 라이브러리에서도 import 되면서 쉽게 circular chunk 가 발생.
//   - 따라서 catch-all 'vendor' 청크에 포함시키는 것이 단순하고 안전.
//
// 순서 주의:
//   manualChunks 는 첫 번째 매칭만 사용되므로, 더 좁은 패턴부터 판정해야
//   오버라이드가 안 됨 (예: '@tiptap/*' 보다 '@tiptap/extension-link' 같은
//   구체 패턴을 먼저 둘 필요는 없지만, 다른 벤더 청크와 겹치면 순서 중요).
// ------------------------------------------------------------

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // 500 KB 기본값 → 800 KB 로 상향 (벤더 청크 하나 정도는 허용)
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          // TipTap — rich text editor (서명/템플릿/메일 본문에서만 쓰임)
          if (id.includes('@tiptap') || id.includes('prosemirror')) {
            return 'vendor-tiptap'
          }

          // 스프레드시트 파서 — 연락처 import 에서만 쓰임
          if (id.includes('/xlsx/') || id.includes('papaparse')) {
            return 'vendor-parsers'
          }

          // 차트 — 대시보드 / 분석 화면에서만
          if (id.includes('recharts') || id.includes('d3-')) {
            return 'vendor-charts'
          }

          // Supabase / React Query — 대부분 페이지 공통
          if (id.includes('@supabase') || id.includes('@tanstack')) {
            return 'vendor-data'
          }

          // Radix UI + lucide — 전역 UI 라이브러리
          if (id.includes('@radix-ui') || id.includes('lucide-react')) {
            return 'vendor-ui'
          }

          // 나머지 (React 생태계 포함) 는 기본 vendor 청크로
          return 'vendor'
        },
      },
    },
  },
})
