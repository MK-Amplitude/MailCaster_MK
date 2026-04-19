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
  inserted: number
  updated: number
  skipped: number
  errors: ImportErrorDetail[]
}

const BATCH_SIZE = 100

export function useContactImport() {
  const { user } = useAuth()
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

    setImporting(true)
    setProgress(0)

    const result: ImportResult = {
      total: rows.length,
      inserted: 0,
      updated: 0,
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

    const resolveQueue: Array<{ id: string; rawName: string }> = []

    const rowToUpsert = (row: ParsedRow) => {
      const company = row[mapping.company]?.trim() || null
      return {
        user_id: user.id,
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

      const { data, error } = await supabase
        .from('contacts')
        .upsert(upsertData, { onConflict: 'user_id,email' })
        .select('id, email, company_raw')

      if (error) {
        // 배치 전체 실패 — 행별로 재시도해서 어느 행이 문제인지 식별
        for (const b of batch) {
          const singleData = rowToUpsert(b.row)
          const { data: one, error: oneErr } = await supabase
            .from('contacts')
            .upsert([singleData], { onConflict: 'user_id,email' })
            .select('id, email, company_raw')
            .single()
          if (oneErr || !one) {
            result.errors.push({
              row: b.displayRow,
              email: singleData.email ?? '',
              message: oneErr?.message ?? '알 수 없는 오류',
            })
          } else {
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
              resolveQueue.push({ id: one.id, rawName: one.company_raw })
            }
          }
        }
      } else if (data) {
        result.inserted += data.length

        if (groupId && data.length > 0) {
          await supabase.from('contact_groups').upsert(
            data.map((c) => ({ contact_id: c.id, group_id: groupId })),
            { onConflict: 'contact_id,group_id', ignoreDuplicates: true }
          )
        }

        for (const c of data) {
          if (c.company_raw) {
            resolveQueue.push({ id: c.id, rawName: c.company_raw })
          }
        }
      }

      setProgress(Math.round(((i + batch.length) / validRows.length) * 100))
    }

    setImporting(false)
    qc.invalidateQueries({ queryKey: ['contacts'] })
    qc.invalidateQueries({ queryKey: ['groups'] })
    toast.success(`가져오기 완료: ${result.inserted}개 처리, ${result.skipped}개 건너뜀`)

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
