import { useEffect, useRef } from 'react'

interface SignaturePreviewProps {
  html: string
  className?: string
}

export function SignaturePreview({ html, className }: SignaturePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (iframeRef.current) {
      const doc = iframeRef.current.contentDocument
      if (doc) {
        doc.open()
        doc.write(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width">
            <style>
              body { margin: 0; padding: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; word-break: break-word; }
              a { color: #3b82f6; }
              img { max-width: 100%; }
            </style>
          </head>
          <body>${html}</body>
          </html>
        `)
        doc.close()
        // 높이 자동 조정
        const height = doc.body.scrollHeight
        iframeRef.current.style.height = `${Math.max(height + 24, 60)}px`
      }
    }
  }, [html])

  return (
    <iframe
      ref={iframeRef}
      title="서명 미리보기"
      sandbox="allow-same-origin"
      className={className}
      style={{ width: '100%', border: 'none', minHeight: '60px' }}
    />
  )
}
