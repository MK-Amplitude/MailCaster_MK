export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

// W8) 상태/모드 enum — DB CHECK 제약이 없으므로 DB 자체는 문자열이지만
//     애플리케이션 레벨에서 type-safe 하게 좁혀 타이핑 오류를 차단한다.
//     (src/types/campaign.ts 의 *Status / SendMode 와 소스 중복이지만 순환 참조 방지를 위해 inline)
export type DbCampaignStatus =
  | 'draft'
  | 'sending'
  | 'sent'
  | 'paused'
  | 'failed'
  | 'scheduled'

export type DbRecipientStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'bounced'
  | 'skipped'

export type DbSendMode = 'individual' | 'bulk'

export interface Database {
  mailcaster: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          display_name: string | null
          google_access_token: string | null
          google_refresh_token: string | null
          token_expires_at: string | null
          signature_html: string | null
          default_sender_name: string | null
          default_cc: string | null
          default_bcc: string | null
          slack_webhook_url: string | null
          slack_channel_name: string | null
          daily_send_count: number
          daily_send_count_date: string | null
          daily_send_limit: number
          created_at: string
        }
        Insert: {
          id: string
          email: string
          display_name?: string | null
          google_access_token?: string | null
          google_refresh_token?: string | null
          token_expires_at?: string | null
          signature_html?: string | null
          default_sender_name?: string | null
          default_cc?: string | null
          default_bcc?: string | null
          slack_webhook_url?: string | null
          slack_channel_name?: string | null
          daily_send_count?: number
          daily_send_count_date?: string | null
          daily_send_limit?: number
          created_at?: string
        }
        Update: {
          id?: string
          email?: string
          display_name?: string | null
          google_access_token?: string | null
          google_refresh_token?: string | null
          token_expires_at?: string | null
          signature_html?: string | null
          default_sender_name?: string | null
          default_cc?: string | null
          default_bcc?: string | null
          slack_webhook_url?: string | null
          slack_channel_name?: string | null
          daily_send_count?: number
          daily_send_count_date?: string | null
          daily_send_limit?: number
        }
        Relationships: []
      }
      contacts: {
        Row: {
          id: string
          user_id: string
          org_id: string
          email: string
          name: string | null
          company: string | null
          company_raw: string | null
          company_ko: string | null
          company_en: string | null
          company_lookup_status: string | null
          company_lookup_at: string | null
          customer_type: string
          department: string | null
          job_title: string | null
          phone: string | null
          timezone: string | null
          memo: string | null
          variables: Json
          is_unsubscribed: boolean
          unsubscribed_at: string | null
          is_bounced: boolean
          bounce_count: number
          last_bounced_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          org_id: string
          email: string
          name?: string | null
          company?: string | null
          company_raw?: string | null
          company_ko?: string | null
          company_en?: string | null
          company_lookup_status?: string | null
          company_lookup_at?: string | null
          customer_type?: string
          department?: string | null
          job_title?: string | null
          phone?: string | null
          timezone?: string | null
          memo?: string | null
          variables?: Json
          is_unsubscribed?: boolean
          unsubscribed_at?: string | null
          is_bounced?: boolean
          bounce_count?: number
          last_bounced_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          email?: string
          name?: string | null
          company?: string | null
          company_raw?: string | null
          company_ko?: string | null
          company_en?: string | null
          company_lookup_status?: string | null
          company_lookup_at?: string | null
          customer_type?: string
          department?: string | null
          job_title?: string | null
          phone?: string | null
          timezone?: string | null
          memo?: string | null
          variables?: Json
          is_unsubscribed?: boolean
          unsubscribed_at?: string | null
          is_bounced?: boolean
          bounce_count?: number
          last_bounced_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      contact_history: {
        Row: {
          id: string
          contact_id: string
          user_id: string
          action: string
          changed_fields: string[]
          snapshot: Json
          changed_at: string
        }
        Insert: {
          id?: string
          contact_id: string
          user_id: string
          action: string
          changed_fields?: string[]
          snapshot: Json
          changed_at?: string
        }
        Update: Record<string, never>
        Relationships: []
      }
      company_cache: {
        Row: {
          id: string
          query_text: string
          query_key: string
          name_ko: string | null
          name_en: string | null
          confidence: number | null
          source: string | null
          raw_response: Json | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          query_text: string
          name_ko?: string | null
          name_en?: string | null
          confidence?: number | null
          source?: string | null
          raw_response?: Json | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          query_text?: string
          name_ko?: string | null
          name_en?: string | null
          confidence?: number | null
          source?: string | null
          raw_response?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      unsubscribes: {
        Row: {
          id: string
          user_id: string
          org_id: string
          email: string
          reason: string | null
          source_campaign_id: string | null
          unsubscribed_at: string
        }
        Insert: {
          id?: string
          user_id: string
          org_id: string
          email: string
          reason?: string | null
          source_campaign_id?: string | null
          unsubscribed_at?: string
        }
        Update: {
          user_id?: string
          org_id?: string
          reason?: string | null
        }
        Relationships: []
      }
      blacklist: {
        Row: {
          id: string
          user_id: string
          org_id: string
          email: string
          reason: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          org_id: string
          email: string
          reason?: string | null
          created_at?: string
        }
        Update: {
          user_id?: string
          org_id?: string
          reason?: string | null
        }
        Relationships: []
      }
      group_categories: {
        Row: {
          id: string
          user_id: string
          org_id: string
          name: string
          description: string | null
          color: string | null
          icon: string | null
          sort_order: number
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          org_id: string
          name: string
          description?: string | null
          color?: string | null
          icon?: string | null
          sort_order?: number
          created_at?: string
        }
        Update: {
          name?: string
          description?: string | null
          color?: string | null
          icon?: string | null
          sort_order?: number
        }
        Relationships: []
      }
      groups: {
        Row: {
          id: string
          user_id: string
          org_id: string
          category_id: string | null
          name: string
          description: string | null
          color: string | null
          member_count: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          org_id: string
          category_id?: string | null
          name: string
          description?: string | null
          color?: string | null
          member_count?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          category_id?: string | null
          name?: string
          description?: string | null
          color?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      contact_groups: {
        Row: {
          id: string
          contact_id: string
          group_id: string
          added_at: string
        }
        Insert: {
          id?: string
          contact_id: string
          group_id: string
          added_at?: string
        }
        Update: {
          id?: string
        }
        Relationships: []
      }
      templates: {
        Row: {
          id: string
          user_id: string
          org_id: string
          name: string
          subject: string
          body_html: string
          variables: string[]
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          org_id: string
          name: string
          subject: string
          body_html: string
          variables?: string[]
          created_at?: string
          updated_at?: string
        }
        Update: {
          name?: string
          subject?: string
          body_html?: string
          variables?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      signatures: {
        Row: {
          id: string
          user_id: string
          org_id: string
          name: string
          html: string
          is_default: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          org_id: string
          name: string
          html: string
          is_default?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          name?: string
          html?: string
          is_default?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      campaigns: {
        Row: {
          id: string
          user_id: string
          org_id: string
          name: string
          template_id: string | null
          signature_id: string | null
          subject: string | null
          body_html: string | null
          status: DbCampaignStatus
          total_count: number
          sent_count: number
          failed_count: number
          open_count: number
          reply_count: number
          unsubscribe_count: number
          bounce_count: number
          send_delay_seconds: number
          include_unsubscribe_link: boolean
          enable_open_tracking: boolean
          draft_data: Json | null
          last_saved_at: string | null
          created_at: string
          scheduled_at: string | null
          cc: string[]
          bcc: string[]
          send_mode: DbSendMode
          // Phase 6 (migration 010) — 스케줄 발송 체크포인트
          sending_started_at: string | null
          last_processed_recipient_id: string | null
        }
        Insert: {
          id?: string
          user_id: string
          org_id: string
          name: string
          template_id?: string | null
          signature_id?: string | null
          subject?: string | null
          body_html?: string | null
          status?: DbCampaignStatus
          total_count?: number
          sent_count?: number
          failed_count?: number
          open_count?: number
          reply_count?: number
          unsubscribe_count?: number
          bounce_count?: number
          send_delay_seconds?: number
          include_unsubscribe_link?: boolean
          enable_open_tracking?: boolean
          draft_data?: Json | null
          last_saved_at?: string | null
          created_at?: string
          scheduled_at?: string | null
          cc?: string[]
          bcc?: string[]
          send_mode?: DbSendMode
          sending_started_at?: string | null
          last_processed_recipient_id?: string | null
        }
        Update: {
          name?: string
          template_id?: string | null
          signature_id?: string | null
          subject?: string | null
          body_html?: string | null
          status?: DbCampaignStatus
          total_count?: number
          sent_count?: number
          failed_count?: number
          open_count?: number
          reply_count?: number
          unsubscribe_count?: number
          bounce_count?: number
          send_delay_seconds?: number
          include_unsubscribe_link?: boolean
          enable_open_tracking?: boolean
          draft_data?: Json | null
          last_saved_at?: string | null
          scheduled_at?: string | null
          cc?: string[]
          bcc?: string[]
          send_mode?: DbSendMode
          sending_started_at?: string | null
          last_processed_recipient_id?: string | null
        }
        Relationships: []
      }
      // Phase 3: 템플릿 블록 조합 발송 (migration 003)
      campaign_blocks: {
        Row: {
          id: string
          campaign_id: string
          template_id: string
          position: number
          created_at: string
        }
        Insert: {
          id?: string
          campaign_id: string
          template_id: string
          position: number
          created_at?: string
        }
        Update: {
          id?: string
          campaign_id?: string
          template_id?: string
          position?: number
          created_at?: string
        }
        Relationships: []
      }
      campaign_groups: {
        Row: {
          id: string
          campaign_id: string
          group_id: string
        }
        Insert: {
          id?: string
          campaign_id: string
          group_id: string
        }
        Update: {
          id?: string
        }
        Relationships: []
      }
      // Phase 5: 바구니 패턴 — 그룹과 병존하는 개별 연락처 선택 (migration 009)
      campaign_contacts: {
        Row: {
          id: string
          campaign_id: string
          contact_id: string
          added_at: string
        }
        Insert: {
          id?: string
          campaign_id: string
          contact_id: string
          added_at?: string
        }
        Update: {
          id?: string
          campaign_id?: string
          contact_id?: string
          added_at?: string
        }
        Relationships: []
      }
      // Phase 7 (migration 012) — CC/BCC 바구니 메타 (편집 복원용)
      campaign_cc_groups: {
        Row: { id: string; campaign_id: string; group_id: string; added_at: string }
        Insert: { id?: string; campaign_id: string; group_id: string; added_at?: string }
        Update: { id?: string; campaign_id?: string; group_id?: string; added_at?: string }
        Relationships: []
      }
      campaign_cc_contacts: {
        Row: { id: string; campaign_id: string; contact_id: string; added_at: string }
        Insert: { id?: string; campaign_id: string; contact_id: string; added_at?: string }
        Update: { id?: string; campaign_id?: string; contact_id?: string; added_at?: string }
        Relationships: []
      }
      campaign_bcc_groups: {
        Row: { id: string; campaign_id: string; group_id: string; added_at: string }
        Insert: { id?: string; campaign_id: string; group_id: string; added_at?: string }
        Update: { id?: string; campaign_id?: string; group_id?: string; added_at?: string }
        Relationships: []
      }
      campaign_bcc_contacts: {
        Row: { id: string; campaign_id: string; contact_id: string; added_at: string }
        Insert: { id?: string; campaign_id: string; contact_id: string; added_at?: string }
        Update: { id?: string; campaign_id?: string; contact_id?: string; added_at?: string }
        Relationships: []
      }
      recipients: {
        Row: {
          id: string
          campaign_id: string
          contact_id: string | null
          email: string
          name: string | null
          variables: Json
          scheduled_at: string | null
          status: DbRecipientStatus
          sent_at: string | null
          error_message: string | null
          opened: boolean
          opened_at: string | null
          open_count: number
          replied: boolean
          replied_at: string | null
          bounced: boolean
          bounced_at: string | null
          followup_stage: number
          next_followup_at: string | null
          followup_stopped: boolean
          gmail_message_id: string | null
          gmail_thread_id: string | null
          created_at: string
          // Phase 6 (migration 010) — 오픈 추적 확장 / 답장 cron 체크
          first_opened_at: string | null
          bounce_reason: string | null
          last_reply_check_at: string | null
        }
        Insert: {
          id?: string
          campaign_id: string
          contact_id?: string | null
          email: string
          name?: string | null
          variables?: Json
          scheduled_at?: string | null
          status?: DbRecipientStatus
          sent_at?: string | null
          error_message?: string | null
          opened?: boolean
          opened_at?: string | null
          open_count?: number
          replied?: boolean
          replied_at?: string | null
          bounced?: boolean
          bounced_at?: string | null
          followup_stage?: number
          next_followup_at?: string | null
          followup_stopped?: boolean
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          created_at?: string
          first_opened_at?: string | null
          bounce_reason?: string | null
          last_reply_check_at?: string | null
        }
        Update: {
          status?: DbRecipientStatus
          sent_at?: string | null
          error_message?: string | null
          opened?: boolean
          opened_at?: string | null
          open_count?: number
          replied?: boolean
          replied_at?: string | null
          bounced?: boolean
          bounced_at?: string | null
          followup_stage?: number
          next_followup_at?: string | null
          followup_stopped?: boolean
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          first_opened_at?: string | null
          bounce_reason?: string | null
          last_reply_check_at?: string | null
        }
        Relationships: []
      }
      followup_steps: {
        Row: {
          id: string
          campaign_id: string
          step_number: number
          delay_days: number
          subject: string | null
          body_html: string
          send_if: string
          stop_if: string
          created_at: string
        }
        Insert: {
          id?: string
          campaign_id: string
          step_number: number
          delay_days: number
          subject?: string | null
          body_html: string
          send_if?: string
          stop_if?: string
          created_at?: string
        }
        Update: {
          delay_days?: number
          subject?: string | null
          body_html?: string
          send_if?: string
          stop_if?: string
        }
        Relationships: []
      }
      followup_logs: {
        Row: {
          id: string
          recipient_id: string
          followup_step_id: string | null
          step_number: number | null
          status: string | null
          gmail_message_id: string | null
          sent_at: string
        }
        Insert: {
          id?: string
          recipient_id: string
          followup_step_id?: string | null
          step_number?: number | null
          status?: string | null
          gmail_message_id?: string | null
          sent_at?: string
        }
        Update: {
          status?: string | null
        }
        Relationships: []
      }
      open_events: {
        Row: {
          id: string
          recipient_id: string
          campaign_id: string
          opened_at: string
          user_agent: string | null
          // Phase 6 (migration 010)
          ip: string | null
        }
        Insert: {
          id?: string
          recipient_id: string
          campaign_id: string
          opened_at?: string
          user_agent?: string | null
          ip?: string | null
        }
        Update: {
          id?: string
          ip?: string | null
        }
        Relationships: []
      }
      // Phase 6 (migration 010) — 수신자 제외 목록
      campaign_exclusions: {
        Row: {
          id: string
          campaign_id: string
          contact_id: string
          excluded_at: string
        }
        Insert: {
          id?: string
          campaign_id: string
          contact_id: string
          excluded_at?: string
        }
        Update: {
          id?: string
          campaign_id?: string
          contact_id?: string
          excluded_at?: string
        }
        Relationships: []
      }
      drive_attachments: {
        Row: {
          id: string
          user_id: string
          drive_file_id: string
          drive_folder_id: string | null
          file_name: string
          file_size: number | null
          mime_type: string | null
          md5_checksum: string | null
          web_view_link: string | null
          is_public_shared: boolean
          source: 'uploaded' | 'picked'
          deleted_from_drive_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          drive_file_id: string
          drive_folder_id?: string | null
          file_name: string
          file_size?: number | null
          mime_type?: string | null
          md5_checksum?: string | null
          web_view_link?: string | null
          is_public_shared?: boolean
          source?: 'uploaded' | 'picked'
          deleted_from_drive_at?: string | null
          created_at?: string
        }
        Update: {
          web_view_link?: string | null
          is_public_shared?: boolean
          deleted_from_drive_at?: string | null
          md5_checksum?: string | null
        }
        Relationships: []
      }
      template_attachments: {
        Row: {
          template_id: string
          attachment_id: string
          sort_order: number
          created_at: string
        }
        Insert: {
          template_id: string
          attachment_id: string
          sort_order?: number
          created_at?: string
        }
        Update: {
          sort_order?: number
        }
        Relationships: []
      }
      campaign_attachments: {
        Row: {
          campaign_id: string
          attachment_id: string
          sort_order: number
          delivery_mode: 'attachment' | 'link' | null
          created_at: string
        }
        Insert: {
          campaign_id: string
          attachment_id: string
          sort_order?: number
          delivery_mode?: 'attachment' | 'link' | null
          created_at?: string
        }
        Update: {
          sort_order?: number
          delivery_mode?: 'attachment' | 'link' | null
        }
        Relationships: []
      }
      recipient_attachments: {
        Row: {
          id: string
          user_id: string
          attachment_id: string
          recipient_id: string | null
          campaign_id: string | null
          recipient_email: string
          recipient_name: string | null
          campaign_name: string | null
          delivery_mode: 'attachment' | 'link'
          sent_at: string
        }
        Insert: {
          id?: string
          user_id: string
          attachment_id: string
          recipient_id?: string | null
          campaign_id?: string | null
          recipient_email: string
          recipient_name?: string | null
          campaign_name?: string | null
          delivery_mode: 'attachment' | 'link'
          sent_at?: string
        }
        Update: {
          id?: string
        }
        Relationships: []
      }
      send_logs: {
        Row: {
          id: string
          recipient_id: string | null
          campaign_id: string | null
          log_type: string
          gmail_message_id: string | null
          gmail_thread_id: string | null
          status: string | null
          error_detail: string | null
          sent_at: string
        }
        Insert: {
          id?: string
          recipient_id?: string | null
          campaign_id?: string | null
          log_type?: string
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          status?: string | null
          error_detail?: string | null
          sent_at?: string
        }
        Update: {
          id?: string
        }
        Relationships: []
      }
      slack_notifications: {
        Row: {
          id: string
          user_id: string
          campaign_id: string | null
          event_type: string | null
          message: string | null
          sent_at: string
        }
        Insert: {
          id?: string
          user_id: string
          campaign_id?: string | null
          event_type?: string | null
          message?: string | null
          sent_at?: string
        }
        Update: {
          id?: string
        }
        Relationships: []
      }
      // Phase 7: Organizations (migrations 013~017)
      organizations: {
        Row: {
          id: string
          name: string
          slug: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          name?: string
          slug?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      org_members: {
        Row: {
          org_id: string
          user_id: string
          role: 'owner' | 'admin' | 'member'
          invited_by: string | null
          joined_at: string
        }
        Insert: {
          org_id: string
          user_id: string
          role?: 'owner' | 'admin' | 'member'
          invited_by?: string | null
          joined_at?: string
        }
        Update: {
          role?: 'owner' | 'admin' | 'member'
        }
        Relationships: []
      }
      org_invitations: {
        Row: {
          id: string
          org_id: string
          email: string
          role: 'admin' | 'member'
          invited_by: string | null
          created_at: string
          accepted_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          email: string
          role?: 'admin' | 'member'
          invited_by?: string | null
          created_at?: string
          accepted_at?: string | null
        }
        Update: {
          accepted_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      contact_with_groups: {
        Row: {
          id: string
          user_id: string
          org_id: string
          email: string
          name: string | null
          company: string | null
          company_raw: string | null
          company_ko: string | null
          company_en: string | null
          company_lookup_status: string | null
          company_lookup_at: string | null
          customer_type: string
          department: string | null
          job_title: string | null
          phone: string | null
          timezone: string | null
          memo: string | null
          variables: Json
          is_unsubscribed: boolean
          unsubscribed_at: string | null
          is_bounced: boolean
          bounce_count: number
          last_bounced_at: string | null
          created_at: string
          updated_at: string
          owner_email: string | null
          owner_name: string | null
          groups: Json
        }
        Relationships: []
      }
      campaign_stats: {
        Row: {
          id: string
          name: string
          status: string
          total_count: number
          sent_count: number
          failed_count: number
          open_count: number
          reply_count: number
          bounce_count: number
          unsubscribe_count: number
          open_rate: number
          reply_rate: number
          created_at: string
          scheduled_at: string | null
        }
        Relationships: []
      }
      attachment_send_stats: {
        Row: {
          attachment_id: string
          user_id: string
          file_name: string
          file_size: number | null
          mime_type: string | null
          web_view_link: string | null
          deleted_from_drive_at: string | null
          created_at: string
          total_sends: number
          unique_recipients: number
          unique_campaigns: number
          last_sent_at: string | null
        }
        Relationships: []
      }
      // Phase 7 (migration 017) — 같은 조직 내 동일 이메일 중복 연락처 dedupe 뷰
      contacts_common: {
        Row: {
          org_id: string
          email_key: string
          email: string
          name: string | null
          company: string | null
          department: string | null
          job_title: string | null
          is_unsubscribed: boolean
          is_bounced: boolean
          first_created_at: string
          last_updated_at: string
          duplicate_count: number
          owners: Json
          contact_ids: string[]
          groups: Json
        }
        Relationships: []
      }
    }
    Functions: {
      // RPC — 내 이메일로 온 미수락 초대를 일괄 수락 (016)
      accept_pending_invitations: {
        Args: Record<string, never>
        Returns: number
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
