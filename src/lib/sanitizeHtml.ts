// HTML 새니타이저 — 수신 메일 / 인용 메일 등 외부 출처 HTML 을 dangerouslySetInnerHTML 에
// 사용하기 전에 반드시 이 함수를 거쳐야 한다.
//
// 공격 시나리오: 외부인이 <img src=x onerror="fetch(...)"> 나 <script> 태그가 담긴
// HTML 이메일을 보내면, 새니타이즈 없이 렌더링할 경우 앱 컨텍스트에서 JS 가 실행된다.
//
// DOMPurify 는 ALLOW 기반 화이트리스트 — 목록에 없는 태그/속성은 전부 제거.
// javascript: URI, onerror=, onload= 등 이벤트 핸들러를 자동으로 제거.

import DOMPurify from 'dompurify'

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { html: true },
    // javascript: / data: URI 는 완전 차단.
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|cid):|[^a-z]|[a-z+.-]*(?:[^a-z+.-:]|$))/i,
    // <style> 는 남겨 메일 레이아웃 유지. <script> / <iframe> / <form> 제거.
    FORBID_TAGS: ['script', 'iframe', 'form', 'input', 'button', 'object', 'embed', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'action'],
    // data: 이미지 허용 (메일 인라인 이미지 보존)
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
  })
}
