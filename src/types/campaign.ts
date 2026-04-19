import type { Database } from './database.types'

export type Campaign = Database['mailcaster']['Tables']['campaigns']['Row']
export type CampaignInsert = Database['mailcaster']['Tables']['campaigns']['Insert']
export type CampaignUpdate = Database['mailcaster']['Tables']['campaigns']['Update']

export type Recipient = Database['mailcaster']['Tables']['recipients']['Row']
export type RecipientInsert = Database['mailcaster']['Tables']['recipients']['Insert']

// campaign_blocks 는 database.types.ts 재생성 전까지 명시 정의
export interface CampaignBlock {
  id: string
  campaign_id: string
  template_id: string
  position: number
  created_at: string
}

export interface CampaignBlockWithTemplate extends CampaignBlock {
  template: {
    id: string
    name: string
    subject: string
    body_html: string
  }
}

export type CampaignStatus =
  | 'draft'
  | 'sending'
  | 'sent'
  | 'paused'
  | 'failed'
  | 'scheduled'

export type RecipientStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'bounced'
  | 'skipped'

// 발송 모드:
//   individual — 수신자별로 Gmail API 를 반복 호출 (기본값, 개인화 변수 사용 가능)
//   bulk       — Gmail API 1회 호출, 수신자 전원을 BCC 에 넣어 브로드캐스트
export type SendMode = 'individual' | 'bulk'
