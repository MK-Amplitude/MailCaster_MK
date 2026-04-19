// 첨부 파일 훅
//
// Drive 업로드 / picker 선택 / 템플릿·캠페인 연결 / 이력 조회
//
// 401 재시도 패턴: drive.ts 호출은 모두 callDrive() 래퍼를 통해 — 토큰 만료 시 자동 refresh 1회 재시도.

import { useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { getFreshGoogleToken, forceRefreshGoogleToken } from '@/lib/googleToken'
import {
  ensureMailCasterFolder,
  uploadFile as driveUpload,
  getFileMeta,
  listDriveFiles,
  type DriveFileMeta,
  type ListDriveFilesOptions,
  type DriveListPage,
} from '@/lib/drive'
import { toast } from 'sonner'
import type { Database } from '@/types/database.types'

type DriveAttachmentRow = Database['mailcaster']['Tables']['drive_attachments']['Row']
type AttachmentSendStat = Database['mailcaster']['Views']['attachment_send_stats']['Row']

export interface AttachmentWithMeta extends DriveAttachmentRow {
  sort_order?: number
  delivery_mode?: 'attachment' | 'link' | null
}

const QK_TEMPLATE = 'template_attachments'
const QK_CAMPAIGN = 'campaign_attachments'
const QK_STATS = 'attachment_stats'
const QK_DRIVE_LIST = 'drive_file_list'

// =============================================================
// Drive 호출 + 401 재시도 공통 래퍼
// =============================================================

async function callDrive<T>(
  userId: string,
  fn: (token: string) => Promise<T>
): Promise<T> {
  let token = await getFreshGoogleToken(userId)
  try {
    return await fn(token)
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 401) {
      console.log('[useAttachments] 401 → forcing token refresh')
      token = await forceRefreshGoogleToken()
      return await fn(token)
    }
    throw e
  }
}

// =============================================================
// 조회 — 템플릿/캠페인 별 첨부 목록
// =============================================================

export function useTemplateAttachments(templateId: string | undefined) {
  return useQuery({
    queryKey: [QK_TEMPLATE, templateId],
    queryFn: async (): Promise<AttachmentWithMeta[]> => {
      if (!templateId) return []
      const { data, error } = await supabase
        .from('template_attachments')
        .select('sort_order, drive_attachments(*)')
        .eq('template_id', templateId)
        .order('sort_order', { ascending: true })
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((r: any) => ({
        ...(r.drive_attachments as DriveAttachmentRow),
        sort_order: r.sort_order,
      }))
    },
    enabled: !!templateId,
  })
}

export function useCampaignAttachments(campaignId: string | undefined) {
  return useQuery({
    queryKey: [QK_CAMPAIGN, campaignId],
    queryFn: async (): Promise<AttachmentWithMeta[]> => {
      if (!campaignId) return []
      const { data, error } = await supabase
        .from('campaign_attachments')
        .select('sort_order, delivery_mode, drive_attachments(*)')
        .eq('campaign_id', campaignId)
        .order('sort_order', { ascending: true })
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((r: any) => ({
        ...(r.drive_attachments as DriveAttachmentRow),
        sort_order: r.sort_order,
        delivery_mode: r.delivery_mode,
      }))
    },
    enabled: !!campaignId,
  })
}

// =============================================================
// 내부: Drive 파일 메타 → DB insert (upsert)
// =============================================================

async function upsertDriveAttachment(
  userId: string,
  meta: DriveFileMeta,
  folderId: string | null,
  source: 'uploaded' | 'picked'
): Promise<DriveAttachmentRow> {
  const { data, error } = await supabase
    .from('drive_attachments')
    .upsert(
      {
        user_id: userId,
        drive_file_id: meta.id,
        drive_folder_id: folderId,
        file_name: meta.name,
        file_size: meta.size,
        mime_type: meta.mimeType,
        md5_checksum: meta.md5Checksum,
        web_view_link: meta.webViewLink,
        source,
        deleted_from_drive_at: null, // 재업로드 시 삭제 플래그 clear
      },
      { onConflict: 'user_id,drive_file_id' }
    )
    .select()
    .single()
  if (error) throw error
  return data as DriveAttachmentRow
}

// =============================================================
// 업로드 — 로컬 파일을 Drive 에 업로드 + DB insert
// =============================================================

export function useUploadAttachment() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({
      file,
      link,
    }: {
      file: File
      /** 업로드 직후 template/campaign 에 바로 link — 없으면 DB 에만 등록 */
      link?:
        | { type: 'template'; templateId: string; sortOrder?: number }
        | { type: 'campaign'; campaignId: string; sortOrder?: number }
    }): Promise<DriveAttachmentRow> => {
      if (!user) throw new Error('로그인이 필요합니다.')

      const meta = await callDrive(user.id, async (token) => {
        const folderId = await ensureMailCasterFolder(token)
        return { fileMeta: await driveUpload(token, file, folderId), folderId }
      })

      const row = await upsertDriveAttachment(user.id, meta.fileMeta, meta.folderId, 'uploaded')

      if (link?.type === 'template') {
        const { error } = await supabase.from('template_attachments').upsert(
          {
            template_id: link.templateId,
            attachment_id: row.id,
            sort_order: link.sortOrder ?? 0,
          },
          { onConflict: 'template_id,attachment_id' }
        )
        if (error) throw error
      } else if (link?.type === 'campaign') {
        const { error } = await supabase.from('campaign_attachments').upsert(
          {
            campaign_id: link.campaignId,
            attachment_id: row.id,
            sort_order: link.sortOrder ?? 0,
          },
          { onConflict: 'campaign_id,attachment_id' }
        )
        if (error) throw error
      }

      return row
    },
    onSuccess: (_row, vars) => {
      if (vars.link?.type === 'template') {
        qc.invalidateQueries({ queryKey: [QK_TEMPLATE, vars.link.templateId] })
      } else if (vars.link?.type === 'campaign') {
        qc.invalidateQueries({ queryKey: [QK_CAMPAIGN, vars.link.campaignId] })
      }
    },
    onError: (e: Error) => {
      console.error('[useUploadAttachment] failed:', e)
      toast.error(`업로드 실패: ${e.message}`)
    },
  })
}

// =============================================================
// Drive picker — 사용자가 기존 Drive 파일을 선택
// =============================================================

export function useDriveFileList() {
  const { user } = useAuth()

  return useCallback(
    async (opts: ListDriveFilesOptions): Promise<DriveListPage> => {
      if (!user) throw new Error('로그인이 필요합니다.')
      return callDrive(user.id, (token) => listDriveFiles(token, opts))
    },
    [user]
  )
}

/** Drive 에서 선택한 기존 파일을 DB 에 등록 (picked) + 옵션으로 템플릿/캠페인 link */
export function usePickDriveFile() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({
      driveFileId,
      link,
    }: {
      driveFileId: string
      link?:
        | { type: 'template'; templateId: string; sortOrder?: number }
        | { type: 'campaign'; campaignId: string; sortOrder?: number }
    }): Promise<DriveAttachmentRow> => {
      if (!user) throw new Error('로그인이 필요합니다.')

      const meta = await callDrive(user.id, (token) => getFileMeta(token, driveFileId))
      const row = await upsertDriveAttachment(user.id, meta, null, 'picked')

      if (link?.type === 'template') {
        const { error } = await supabase.from('template_attachments').upsert(
          {
            template_id: link.templateId,
            attachment_id: row.id,
            sort_order: link.sortOrder ?? 0,
          },
          { onConflict: 'template_id,attachment_id' }
        )
        if (error) throw error
      } else if (link?.type === 'campaign') {
        const { error } = await supabase.from('campaign_attachments').upsert(
          {
            campaign_id: link.campaignId,
            attachment_id: row.id,
            sort_order: link.sortOrder ?? 0,
          },
          { onConflict: 'campaign_id,attachment_id' }
        )
        if (error) throw error
      }

      return row
    },
    onSuccess: (_row, vars) => {
      if (vars.link?.type === 'template') {
        qc.invalidateQueries({ queryKey: [QK_TEMPLATE, vars.link.templateId] })
      } else if (vars.link?.type === 'campaign') {
        qc.invalidateQueries({ queryKey: [QK_CAMPAIGN, vars.link.campaignId] })
      }
    },
    onError: (e: Error) => {
      console.error('[usePickDriveFile] failed:', e)
      toast.error(`Drive 선택 실패: ${e.message}`)
    },
  })
}

// =============================================================
// 해제 (DB link 만 제거 — Drive 파일은 유지)
// =============================================================

export function useUnlinkTemplateAttachment() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({
      templateId,
      attachmentId,
    }: {
      templateId: string
      attachmentId: string
    }) => {
      const { error } = await supabase
        .from('template_attachments')
        .delete()
        .eq('template_id', templateId)
        .eq('attachment_id', attachmentId)
      if (error) throw error
    },
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: [QK_TEMPLATE, vars.templateId] })
    },
    onError: (e: Error) => toast.error(`해제 실패: ${e.message}`),
  })
}

export function useUnlinkCampaignAttachment() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({
      campaignId,
      attachmentId,
    }: {
      campaignId: string
      attachmentId: string
    }) => {
      const { error } = await supabase
        .from('campaign_attachments')
        .delete()
        .eq('campaign_id', campaignId)
        .eq('attachment_id', attachmentId)
      if (error) throw error
    },
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: [QK_CAMPAIGN, vars.campaignId] })
    },
    onError: (e: Error) => toast.error(`해제 실패: ${e.message}`),
  })
}

// =============================================================
// 이력 — attachment_send_stats 뷰
// =============================================================

export function useAttachmentSendStats() {
  const { user } = useAuth()

  return useQuery({
    queryKey: [QK_STATS],
    queryFn: async (): Promise<AttachmentSendStat[]> => {
      const { data, error } = await supabase
        .from('attachment_send_stats')
        .select('*')
        .eq('user_id', user!.id)
        .order('last_sent_at', { ascending: false, nullsFirst: false })
      if (error) throw error
      return (data ?? []) as AttachmentSendStat[]
    },
    enabled: !!user,
  })
}

/** 특정 파일이 누구에게 발송됐는지 드릴다운 */
export function useAttachmentRecipients(attachmentId: string | undefined) {
  return useQuery({
    queryKey: ['attachment_recipients', attachmentId],
    queryFn: async () => {
      if (!attachmentId) return []
      const { data, error } = await supabase
        .from('recipient_attachments')
        .select('*')
        .eq('attachment_id', attachmentId)
        .order('sent_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    enabled: !!attachmentId,
  })
}

export function useDriveFileListQuery(
  opts: ListDriveFilesOptions = {},
  /** 추가 enabled 플래그 — 다이얼로그 닫혀있을 때 쿼리 방지용 */
  enabled = true
) {
  const { user } = useAuth()

  return useQuery({
    queryKey: [QK_DRIVE_LIST, opts.query ?? '', opts.mimeTypePrefix ?? '', opts.pageToken ?? ''],
    queryFn: async (): Promise<DriveListPage> => {
      if (!user) throw new Error('로그인이 필요합니다.')
      return callDrive(user.id, (token) => listDriveFiles(token, opts))
    },
    enabled: !!user && enabled,
    staleTime: 30_000,
  })
}
