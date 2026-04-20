import type { Database } from './database.types'

export type Template = Database['mailcaster']['Tables']['templates']['Row']
export type TemplateInsert = Database['mailcaster']['Tables']['templates']['Insert']
export type TemplateUpdate = Database['mailcaster']['Tables']['templates']['Update']

// 리스트 조회 결과 — useTemplates 가 profiles 를 조인해 오너 정보를 함께 반환
export interface TemplateWithOwner extends Template {
  profiles: {
    email: string
    display_name: string | null
  } | null
}

// 템플릿 본문/제목에 삽입 가능한 변수 목록
export const TEMPLATE_VARIABLES = [
  { key: 'name', label: '이름' },
  { key: 'email', label: '이메일' },
  { key: 'company', label: '회사' },
  { key: 'department', label: '부서' },
  { key: 'job_title', label: '직책' },
] as const

export type TemplateVariableKey = (typeof TEMPLATE_VARIABLES)[number]['key']
