import type { Database } from './database.types'

export type Template = Database['mailcaster']['Tables']['templates']['Row']
export type TemplateInsert = Database['mailcaster']['Tables']['templates']['Insert']
export type TemplateUpdate = Database['mailcaster']['Tables']['templates']['Update']

// 템플릿 본문/제목에 삽입 가능한 변수 목록
export const TEMPLATE_VARIABLES = [
  { key: 'name', label: '이름' },
  { key: 'email', label: '이메일' },
  { key: 'company', label: '회사' },
  { key: 'department', label: '부서' },
  { key: 'job_title', label: '직책' },
] as const

export type TemplateVariableKey = (typeof TEMPLATE_VARIABLES)[number]['key']
