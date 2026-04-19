import Image from '@tiptap/extension-image'
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * ResizableImage — TipTap `Image` 의 서브 클래스.
 *
 * 목적:
 *   - 본문/서명 에디터에서 이미지 크기를 드래그로 조정할 수 있게 한다.
 *   - 조정한 크기가 HTML 로 저장되고, 불러올 때 그대로 복원된다.
 *
 * 왜 `width` / `height` **attribute** 로 저장하나:
 *   - 이 에디터의 결과물은 결국 Gmail 등으로 발송되는 이메일. Gmail 은
 *     `<img width="..." height="...">` 의 HTML 속성은 잘 존중하지만
 *     inline `style` 은 일부 필터링하는 경우가 있다. 호환성 최우선.
 *   - 에디터 내부 표시용으로만 React 컴포넌트가 img 에 `style` 을 같이 넣는다.
 *     (Tailwind preflight 의 `h-auto` 가 attribute 만으로는 덮어져서
 *      크기가 반영 안 되는 것을 회피하기 위함. 저장 시에는 renderHTML 에서
 *      순수 attribute 로만 직렬화됨.)
 *
 * 조작 UX:
 *   - 이미지 클릭 → NodeSelection → 핸들 4 개(모서리) 표시
 *   - 모서리 드래그: aspect ratio 유지하며 리사이즈
 *   - Shift + 드래그: free resize (aspect ratio 해제)
 *   - 최소 40px / 최대 2000px (메일 본문 기준 과도한 크기 방지)
 *
 * 트레이드오프:
 *   - 좌/우 핸들을 drag 할 때 수직 이동은 무시한다. `dx` 만으로 계산하고
 *     세로는 aspect ratio 로 파생. 실전 UX 에서 가장 혼란이 적음.
 *     (수직/수평 양쪽을 다 보면 커서와 이미지 윤곽이 어긋나 오히려 어색.)
 *   - 좌상/우상/좌하/우하 방향 모두 동일한 방식 — 좌측 코너는 dx 부호만 뒤집음.
 */
function ResizableImageView({ node, selected, updateAttributes }: NodeViewProps) {
  const { src, alt, title, width, height } = node.attrs as {
    src: string
    alt?: string | null
    title?: string | null
    width?: number | null
    height?: number | null
  }
  const imgRef = useRef<HTMLImageElement>(null)
  const dimsRef = useRef<HTMLDivElement>(null)
  const [isResizing, setIsResizing] = useState(false)

  const startResize = (
    e: React.PointerEvent<HTMLDivElement>,
    corner: 'tl' | 'tr' | 'bl' | 'br',
  ) => {
    // 핸들 클릭을 ProseMirror 가 "이미지 선택 해제" 로 해석하지 않도록 차단
    e.preventDefault()
    e.stopPropagation()
    const img = imgRef.current
    if (!img) return

    const startX = e.clientX
    // offsetWidth/Height 는 현재 실제 렌더링된 크기 — 속성이 없어도 자연 크기 반영
    const startWidth = img.offsetWidth
    const startHeight = img.offsetHeight
    const aspectRatio = startHeight > 0 ? startWidth / startHeight : 1
    // 왼쪽 코너는 마우스가 오른쪽으로 움직일 때 width 가 *줄어야* 한다
    const horizontalDir = corner === 'tr' || corner === 'br' ? 1 : -1

    setIsResizing(true)

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      let newWidth = Math.round(startWidth + dx * horizontalDir)
      newWidth = Math.max(40, Math.min(newWidth, 2000))
      // Shift: aspect ratio 해제 (세로도 dx 에 따라 독립적으로 움직이게)
      // 기본: aspect ratio 유지
      const newHeight = ev.shiftKey
        ? Math.max(
            40,
            Math.round(startHeight + (dx * horizontalDir) / aspectRatio),
          )
        : Math.round(newWidth / aspectRatio)

      // 리사이즈 프리뷰는 React state 우회 → inline style 로 즉시 반영
      // (매 frame React re-render 는 과잉)
      img.style.width = `${newWidth}px`
      img.style.height = `${newHeight}px`
      if (dimsRef.current) {
        dimsRef.current.textContent = `${newWidth} × ${newHeight}`
      }
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setIsResizing(false)
      if (img) {
        // attribute 로 commit → renderHTML 이 <img width="..." height="..."> 로 직렬화
        updateAttributes({
          width: img.offsetWidth,
          height: img.offsetHeight,
        })
        // React re-render 후 style prop 으로 다시 세팅되지만, 명시적으로 비워
        // "attribute 가 source of truth" 를 코드로 드러낸다.
        img.style.width = ''
        img.style.height = ''
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const showHandles = selected || isResizing
  const inlineSize =
    width && height
      ? { width: `${width}px`, height: `${height}px` }
      : undefined

  return (
    <NodeViewWrapper
      as="div"
      className={cn(
        'resizable-image',
        selected && 'resizable-image-selected',
      )}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt || ''}
        title={title || undefined}
        style={inlineSize}
        draggable={false}
      />
      {showHandles && (
        <>
          <div
            className="resize-handle resize-handle-tl"
            onPointerDown={(e) => startResize(e, 'tl')}
            aria-label="좌상 리사이즈"
          />
          <div
            className="resize-handle resize-handle-tr"
            onPointerDown={(e) => startResize(e, 'tr')}
            aria-label="우상 리사이즈"
          />
          <div
            className="resize-handle resize-handle-bl"
            onPointerDown={(e) => startResize(e, 'bl')}
            aria-label="좌하 리사이즈"
          />
          <div
            className="resize-handle resize-handle-br"
            onPointerDown={(e) => startResize(e, 'br')}
            aria-label="우하 리사이즈"
          />
          {isResizing && (
            <div ref={dimsRef} className="resize-dimensions" aria-live="polite" />
          )}
        </>
      )}
    </NodeViewWrapper>
  )
}

/**
 * TipTap Image 확장 — width/height attribute 추가 + React NodeView 연결.
 *
 * `this.parent?.()` 로 기존 Image 의 addAttributes 를 그대로 상속받고,
 * 그 위에 width/height 만 덧붙인다. src/alt/title 등은 부모가 관리.
 */
export const ResizableImage = Image.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {}
    return {
      ...parent,
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.getAttribute('width')
          if (!w) return null
          const n = parseInt(w, 10)
          return Number.isFinite(n) ? n : null
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.width) return {}
          return { width: String(attrs.width) }
        },
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const h = el.getAttribute('height')
          if (!h) return null
          const n = parseInt(h, 10)
          return Number.isFinite(n) ? n : null
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.height) return {}
          return { height: String(attrs.height) }
        },
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView)
  },
})
