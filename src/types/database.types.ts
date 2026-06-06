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
          // 038 — Outreach 통합용 컬럼 (현재 inert, 코드 revert 됨)
          outreach_access_token: string | null
          outreach_refresh_token: string | null
          outreach_token_expires_at: string | null
          outreach_user_id: number | null
          outreach_connected_at: string | null
          // 039 — Google Contacts 동기화 상태
          google_contacts_sync_token: string | null
          google_contacts_last_sync_at: string | null
          google_contacts_auto_sync: boolean
          // 056 — check-inbox cron 의 incremental 폴링 cursor
          last_inbox_check_at: string | null
          // 067 — check-inbox Gmail History API 커서
          last_history_id: string | null
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
          outreach_access_token?: string | null
          outreach_refresh_token?: string | null
          outreach_token_expires_at?: string | null
          outreach_user_id?: number | null
          outreach_connected_at?: string | null
          google_contacts_sync_token?: string | null
          google_contacts_last_sync_at?: string | null
          google_contacts_auto_sync?: boolean
          last_inbox_check_at?: string | null
          last_history_id?: string | null
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
          outreach_access_token?: string | null
          outreach_refresh_token?: string | null
          outreach_token_expires_at?: string | null
          outreach_user_id?: number | null
          outreach_connected_at?: string | null
          google_contacts_sync_token?: string | null
          google_contacts_last_sync_at?: string | null
          google_contacts_auto_sync?: boolean
          last_inbox_check_at?: string | null
          last_history_id?: string | null
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
          parent_group: string | null
          display_title: string | null
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
          archived_at: string | null
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
          parent_group?: string | null
          display_title?: string | null
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
          archived_at?: string | null
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
          parent_group?: string | null
          display_title?: string | null
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
          archived_at?: string | null
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
          // 058 — broadcast (다중) vs one_to_one (1:1) 구분
          kind: 'broadcast' | 'one_to_one'
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
          kind?: 'broadcast' | 'one_to_one'
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
          kind?: 'broadcast' | 'one_to_one'
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
          // Phase 11 (migration 031) — AI 개인화 발송 per-recipient override
          subject_override: string | null
          body_html_override: string | null
          // 038 — Outreach 통합용 (현재 inert, 코드 revert 됨. 컬럼만 유지)
          outreach_mailing_id: number | null
          outreach_synced_at: string | null
          outreach_sync_error: string | null
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
          subject_override?: string | null
          body_html_override?: string | null
          outreach_mailing_id?: number | null
          outreach_synced_at?: string | null
          outreach_sync_error?: string | null
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
          subject_override?: string | null
          body_html_override?: string | null
          outreach_mailing_id?: number | null
          outreach_synced_at?: string | null
          outreach_sync_error?: string | null
        }
        Relationships: []
      }
      // 045 — 캠페인 발송 후 1:1 후속 메일 (팔로업/회신/전달)
      thread_messages: {
        Row: {
          id: string
          org_id: string
          user_id: string | null
          campaign_id: string | null
          recipient_id: string | null
          contact_id: string | null
          mode: 'followup' | 'reply' | 'forward' | 'new'
          to_email: string
          to_name: string | null
          cc: string[]
          bcc: string[]
          subject: string | null
          body_html: string | null
          gmail_thread_id: string | null
          gmail_message_id: string | null
          in_reply_to_message_id: string | null
          status: 'pending' | 'sent' | 'failed'
          sent_at: string | null
          error_message: string | null
          created_at: string
          // 046 — 오픈 추적
          opened: boolean
          first_opened_at: string | null
          last_opened_at: string | null
          open_count: number
          // 047 — 회신 추적
          replied: boolean
          replied_at: string | null
          last_reply_check_at: string | null
          reply_count: number
          // 050 — 우리가 보낸 메시지의 RFC Message-ID (회신 In-Reply-To 매칭용)
          rfc_message_id: string | null
          // 051 — bounce 추적
          bounced: boolean
          bounced_at: string | null
          bounce_reason: string | null
          // 068 — 시퀀스 링크 (스텝 퍼널)
          sequence_id: string | null
          sequence_step_order: number | null
        }
        Insert: {
          id?: string
          org_id: string
          user_id?: string | null
          campaign_id?: string | null
          recipient_id?: string | null
          contact_id?: string | null
          mode: 'followup' | 'reply' | 'forward' | 'new'
          to_email: string
          to_name?: string | null
          cc?: string[]
          bcc?: string[]
          subject?: string | null
          body_html?: string | null
          gmail_thread_id?: string | null
          gmail_message_id?: string | null
          in_reply_to_message_id?: string | null
          status?: 'pending' | 'sent' | 'failed'
          sent_at?: string | null
          error_message?: string | null
          created_at?: string
          opened?: boolean
          first_opened_at?: string | null
          last_opened_at?: string | null
          open_count?: number
          replied?: boolean
          replied_at?: string | null
          last_reply_check_at?: string | null
          reply_count?: number
          rfc_message_id?: string | null
          bounced?: boolean
          bounced_at?: string | null
          bounce_reason?: string | null
          sequence_id?: string | null
          sequence_step_order?: number | null
        }
        Update: {
          gmail_thread_id?: string | null
          gmail_message_id?: string | null
          status?: 'pending' | 'sent' | 'failed'
          sent_at?: string | null
          error_message?: string | null
          opened?: boolean
          first_opened_at?: string | null
          last_opened_at?: string | null
          open_count?: number
          replied?: boolean
          replied_at?: string | null
          last_reply_check_at?: string | null
          reply_count?: number
          rfc_message_id?: string | null
          bounced?: boolean
          bounced_at?: string | null
          bounce_reason?: string | null
        }
        Relationships: []
      }
      // 047 — thread_messages 에 받은 회신 본문/메타
      thread_message_replies: {
        Row: {
          id: string
          thread_message_id: string
          org_id: string
          gmail_message_id: string
          gmail_thread_id: string | null
          rfc_message_id: string | null
          from_email: string | null
          from_name: string | null
          subject: string | null
          snippet: string | null
          body_text: string | null
          received_at: string
          created_at: string
        }
        Insert: {
          id?: string
          thread_message_id: string
          org_id: string
          gmail_message_id: string
          gmail_thread_id?: string | null
          rfc_message_id?: string | null
          from_email?: string | null
          from_name?: string | null
          subject?: string | null
          snippet?: string | null
          body_text?: string | null
          received_at?: string
          created_at?: string
        }
        Update: {
          subject?: string | null
          body_text?: string | null
        }
        Relationships: []
      }
      // 056 — Inbound mail tracking (contact 가 우리에게 먼저 보낸 메일)
      inbound_messages: {
        Row: {
          id: string
          org_id: string
          user_id: string | null
          contact_id: string | null
          gmail_message_id: string
          gmail_thread_id: string | null
          rfc_message_id: string | null
          from_email: string
          from_name: string | null
          to_emails: string[]
          subject: string | null
          snippet: string | null
          body_text: string | null
          body_html: string | null
          received_at: string
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id?: string | null
          contact_id?: string | null
          gmail_message_id: string
          gmail_thread_id?: string | null
          rfc_message_id?: string | null
          from_email: string
          from_name?: string | null
          to_emails?: string[]
          subject?: string | null
          snippet?: string | null
          body_text?: string | null
          body_html?: string | null
          received_at?: string
          created_at?: string
        }
        Update: Record<string, never>
        Relationships: []
      }
      sequences: {
        Row: {
          id: string
          org_id: string
          user_id: string
          name: string
          description: string | null
          status: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          name: string
          description?: string | null
          status?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          name?: string
          description?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      sequence_steps: {
        Row: {
          id: string
          sequence_id: string
          step_order: number
          wait_days: number
          subject: string
          body_html: string
          created_at: string
        }
        Insert: {
          id?: string
          sequence_id: string
          step_order: number
          wait_days?: number
          subject: string
          body_html?: string
          created_at?: string
        }
        Update: {
          step_order?: number
          wait_days?: number
          subject?: string
          body_html?: string
        }
        Relationships: []
      }
      sequence_enrollments: {
        Row: {
          id: string
          org_id: string
          sequence_id: string
          contact_id: string
          status: string
          current_step_order: number
          next_step_order: number
          next_run_at: string | null
          stopped_reason: string | null
          last_thread_id: string | null
          last_rfc_message_id: string | null
          last_error: string | null
          enrolled_by: string | null
          enrolled_at: string
          completed_at: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          sequence_id: string
          contact_id: string
          status?: string
          current_step_order?: number
          next_step_order?: number
          next_run_at?: string | null
          stopped_reason?: string | null
          last_thread_id?: string | null
          last_rfc_message_id?: string | null
          last_error?: string | null
          enrolled_by?: string | null
          enrolled_at?: string
          completed_at?: string | null
          updated_at?: string
        }
        Update: {
          status?: string
          current_step_order?: number
          next_step_order?: number
          next_run_at?: string | null
          stopped_reason?: string | null
          last_thread_id?: string | null
          last_rfc_message_id?: string | null
          last_error?: string | null
          completed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      org_send_settings: {
        Row: {
          org_id: string
          daily_send_limit: number
          window_start_hour: number
          window_end_hour: number
          send_on_weekends: boolean
          timezone: string
          warmup_start: number
          warmup_per_day: number
          warmup_started_at: string | null
          updated_at: string
        }
        Insert: {
          org_id: string
          daily_send_limit?: number
          window_start_hour?: number
          window_end_hour?: number
          send_on_weekends?: boolean
          timezone?: string
          warmup_start?: number
          warmup_per_day?: number
          warmup_started_at?: string | null
          updated_at?: string
        }
        Update: {
          daily_send_limit?: number
          window_start_hour?: number
          window_end_hour?: number
          send_on_weekends?: boolean
          timezone?: string
          warmup_start?: number
          warmup_per_day?: number
          warmup_started_at?: string | null
          updated_at?: string
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
          parent_group: string | null
          display_title: string | null
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
          archived_at: string | null
          created_at: string
          updated_at: string
          owner_email: string | null
          owner_name: string | null
          groups: Json
        }
        Relationships: []
      }
      contact_engagement: {
        Row: {
          id: string
          org_id: string
          user_id: string
          email: string
          name: string | null
          company: string | null
          company_ko: string | null
          company_en: string | null
          parent_group: string | null
          customer_type: string | null
          department: string | null
          job_title: string | null
          display_title: string | null
          is_unsubscribed: boolean
          is_bounced: boolean
          contact_created_at: string
          sent_campaigns: number
          total_sent: number
          total_opens: number
          reply_count: number
          last_sent_at: string | null
          last_opened_at: string | null
          last_replied_at: string | null
          last_campaign: Json | null
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
      // RPC — 1년+ 비활성 연락처 자동 보관 (036)
      archive_inactive_contacts: {
        Args: { p_org_id?: string; p_threshold_days?: number }
        Returns: number
      }
      // RPC — bulk 보관/복원 (042) — 조직 멤버라면 owner 와 무관
      bulk_set_archived: {
        Args: { p_org_id: string; p_contact_ids: string[]; p_archive: boolean }
        Returns: number
      }
      // RPC — bulk 반송 해제 (043)
      bulk_clear_bounce: {
        Args: { p_org_id: string; p_contact_ids: string[] }
        Returns: number
      }
      // RPC — bulk 수신거부 / 해제 (043)
      bulk_set_unsubscribed: {
        Args: { p_org_id: string; p_contact_ids: string[]; p_unsubscribe: boolean }
        Returns: number
      }
      // RPC — bulk 고객 분류 변경 (043)
      bulk_update_customer_type: {
        Args: { p_org_id: string; p_contact_ids: string[]; p_customer_type: string }
        Returns: number
      }
      // RPC — 받은편지함 KPI 집계 (060)
      inbox_stats: {
        Args: { p_since: string; p_today_start: string }
        Returns: {
          total: number
          today_count: number
          unreplied_count: number
          outbound_sent: number
          outbound_opened: number
        }[]
      }
      // RPC — 시퀀스 등록 (062)
      enroll_contacts_in_sequence: {
        Args: { p_sequence_id: string; p_contact_ids: string[] }
        Returns: number
      }
      // RPC — 시퀀스 등록 중단 (062)
      stop_enrollment: {
        Args: { p_enrollment_id: string; p_reason?: string }
        Returns: boolean
      }
      // RPC — outbound 퍼널 집계 (066)
      outbound_funnel: {
        Args: { p_since: string }
        Returns: { sent: number; opened: number; replied: number }[]
      }
      // RPC — 세그먼트별 성과 집계 (066)
      reply_rate_by_segment: {
        Args: { p_since: string; p_dim: string }
        Returns: { segment: string; sent: number; opened: number; replied: number }[]
      }
      // RPC — 시퀀스 스텝별 퍼널 (068)
      sequence_step_funnel: {
        Args: { p_sequence_id: string }
        Returns: { step_order: number; sent: number; opened: number; replied: number }[]
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
