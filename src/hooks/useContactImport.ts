import { useState } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { isValidEmail } from '@/lib/utils'
import { resolveCompaniesBatch } from '@/lib/resolveCompany'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export interface ParsedRow {
  [key: string]: string
}

export interface ColumnMapping {
  email: string
  name: string
  company: string
  department: string
  job_title: string
  phone: string
  [key: string]: string
}

export interface ImportErrorDetail {
  row: number
  email: string
  message: string
}

export interface ImportResult {
  total: number
  inserted: number       // 신규 추가
  updated: number        // 사용 안 함 — 보존 정책상 항상 0 (호환 위해 유지)
  duplicates: number     // 이미 존재 — 기존 데이터 보존, 덮어쓰지 않음
  skipped: number        // 이메일 없음 / 형식 오류 등 invalid
  errors: ImportErrorDetail[]
}

const BATCH_SIZE = 100

export function useContactImport() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [progress, setProgress] = useState(0)
  const [importing, setImporting] = useState(false)

  const parseFile = async (file: File): Promise<void> => {
    const ext = file.name.split('.').pop()?.toLowerCase()

    if (ext === 'csv') {
      return new Promise((resolve, reject) => {
        Papa.parse<ParsedRow>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            setHeaders(results.meta.fields ?? [])
            setRows(results.data)
            resolve()
          },
          error: reject,
        })
      })
    }

    if (ext === 'xlsx' || ext === 'xls') {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json<ParsedRow>(ws, { defval: '' })
      if (data.length > 0) {
        setHeaders(Object.keys(data[0]))
        setRows(data)
      }
      return
    }

    throw new Error('CSV 또는 XLSX 파일만 지원합니다.')
  }

  const runImport = async (
    mapping: ColumnMapping,
    groupId?: string
  ): Promise<ImportResult> => {
    if (!user) throw new Error('로그인이 필요합니다.')
    if (!currentOrg) throw new Error('현재 조직이 설정되지 않았습니다.')

    setImporting(true)
    setProgress(0)

    const result: ImportResult = {
      total: rows.length,
      inserted: 0,
      updated: 0,
      duplicates: 0,
      skipped: 0,
      errors: [],
    }

    // rows[0] 은 파싱된 첫 데이터 행 → 사용자가 스프레드시트에서 보는 행 번호는 +2 (헤더 1줄 + 1-based)
    const validRows: Array<{ row: ParsedRow; displayRow: number }> = []
    rows.forEach((row, idx) => {
      const email = row[mapping.email]?.trim()
      const displayRow = idx + 2
      if (!email) {
        result.skipped++
        result.errors.push({ row: displayRow, email: '', message: '이메일 없음' })
        return
      }
      if (!isValidEmail(email)) {
        result.skipped++
        result.errors.push({ row: displayRow, email, message: '이메일 형식 오류' })
        return
      }
      validRows.push({ row, displayRow })
    })

    const resolveQueue: Array<{ id: string; rawName: string; email?: string | null }> = []

    const rowToUpsert = (row: ParsedRow) => {
      const company = row[mapping.company]?.trim() || null
      return {
        user_id: user.id,
        org_id: currentOrg.id,
        email: row[mapping.email]?.trim().toLowerCase(),
        name: row[mapping.name]?.trim() || null,
        company,
        company_raw: company,
        company_lookup_status: company ? 'pending' : 'skipped',
        department: row[mapping.department]?.trim() || null,
        job_title: row[mapping.job_title]?.trim() || null,
        phone: row[mapping.phone]?.trim() || null,
      }
    }

    for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
      const batch = validRows.slice(i, i + BATCH_SIZE)
      const upsertData = batch.map((b) => rowToUpsert(b.row))

      // 보존 정책: ignoreDuplicates=true → ON CONFLICT DO NOTHING.
      // 이메일이 이미 존재하는 행은 기존 데이터를 덮어쓰지 않고 그대로 둠.
      // .select() 는 새로 INSERT 된 행만 반환 — duplicates 수는 batch 길이 차로 계산.
      const { data, error } = await supabase
        .from('contacts')
        .upsert(upsertData, { onConflict: 'user_id,email', ignoreDuplicates: true })
        .select('id, email, company_raw')

      // 기존 행을 찾기 위해 batch 이메일들을 사전 lookup — duplicates 에 어떤 행이
      // 그룹에 추가되어야 하는지 알기 위해 필요. (groupId 가 있을 때만.)
      // 신규/기존 구분: data 에 있는 email = 신규. 그 외 = 기존.

      if (error) {
        // 배치 전체 실패 — 행별로 재시도
        for (const b of batch) {
          const singleData = rowToUpsert(b.row)
          const { data: one, error: oneErr } = await supabase
            .from('contacts')
            .upsert([singleData], { onConflict: 'user_id,email', ignoreDuplicates: true })
            .select('id, email, company_raw')
            .maybeSingle()
          if (oneErr) {
            result.errors.push({
              row: b.displayRow,
              email: singleData.email ?? '',
              message: oneErr.message,
            })
          } else if (one) {
            // 신규 — INSERT 됨
            result.inserted++
            if (groupId) {
              await supabase
                .from('contact_groups')
                .upsert(
                  [{ contact_id: one.id, group_id: groupId }],
                  { onConflict: 'contact_id,group_id', ignoreDuplicates: true }
                )
            }
            if (one.company_raw) {
              resolveQueue.push({ id: one.id, rawName: one.company_raw, email: one.email })
            }
          } else {
            // 기존 행 — INSERT 안 됨. 기존 데이터 보존.
            // groupId 가 있으면 기존 contact_id 를 찾아 그룹에만 추가.
            result.duplicates++
            if (groupId) {
              const { data: existing } = await supabase
                .from('contacts')
                .select('id')
                .eq('user_id', user.id)
                .eq('email', singleData.email!)
                .maybeSingle()
              if (existing) {
                await supabase
                  .from('contact_groups')
                  .upsert(
                    [{ contact_id: existing.id, group_id: groupId }],
                    { onConflict: 'contact_id,group_id', ignoreDuplicates: true }
                  )
              }
            }
          }
        }
      } else {
        const inserted = data ?? []
        result.inserted += inserted.length
        result.duplicates += batch.length - inserted.length

        if (groupId && inserted.length > 0) {
          await supabase.from('contact_groups').upsert(
            inserted.map((c) => ({ contact_id: c.id, group_id: groupId })),
            { onConflict: 'contact_id,group_id', ignoreDuplicates: true }
          )
        }

        // 기존(중복) 행도 그룹에 추가 — 사용자가 "특정 그룹으로 import" 한 의도 존중.
        if (groupId && inserted.length < batch.length) {
          const insertedEmails = new Set(inserted.map((c) => c.email))
          const duplicateEmails = upsertData
            .map((d) => d.email!)
            .filter((e) => !insertedEmails.has(e))
          if (duplicateEmails.length > 0) {
            const { data: existingRows } = await supabase
              .from('contacts')
              .select('id, email')
              .eq('user_id', user.id)
              .in('email', duplicateEmails)
            if (existingRows && existingRows.length > 0) {
              await supabase.from('contact_groups').upsert(
                existingRows.map((c) => ({ contact_id: c.id, group_id: groupId })),
                { onConflict: 'contact_id,group_id', ignoreDuplicates: true }
              )
            }
          }
        }

        for (const c of inserted) {
          if (c.company_raw) {
            resolveQueue.push({ id: c.id, rawName: c.company_raw, email: c.email })
          }
        }
      }

      setProgress(Math.round(((i + batch.length) / validRows.length) * 100))
    }

    setImporting(false)
    qc.invalidateQueries({ queryKey: ['contacts'] })
    qc.invalidateQueries({ queryKey: ['contacts-common'] })
    qc.invalidateQueries({ queryKey: ['groups'] })
    toast.success(
      `가져오기 완료: 신규 ${result.inserted}명${
        result.duplicates > 0 ? `, 이미 존재 ${result.duplicates}명 (덮어쓰지 않음)` : ''
      }${result.skipped > 0 ? `, 건너뜀 ${result.skipped}건` : ''}`
    )

    // 비동기 백그라운드 — 사용자를 블록하지 않음
    if (resolveQueue.length > 0) {
      toast.info(`${resolveQueue.length}개 연락처의 회사명을 정규화합니다...`)
      resolveCompaniesBatch(resolveQueue, qc)
        .then(() => toast.success('회사명 정규화 완료'))
        .catch((e) => console.error('[batch resolve] failed:', e))
    }

    return result
  }

  const reset = () => {
    setRows([])
    setHeaders([])
    setProgress(0)
  }

  return { rows, headers, progress, importing, parseFile, runImport, reset }
}
