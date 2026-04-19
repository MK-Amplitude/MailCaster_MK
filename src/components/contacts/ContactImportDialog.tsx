import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { Upload, CheckCircle2, AlertCircle, Download, ChevronDown, ChevronRight } from 'lucide-react'
import { useContactImport, type ColumnMapping } from '@/hooks/useContactImport'
import type { ImportResult, ImportErrorDetail } from '@/hooks/useContactImport'

const FIELD_LABELS: Record<string, string> = {
  email: '이메일 *',
  name: '이름',
  company: '회사',
  department: '부서',
  job_title: '직책',
  phone: '전화번호',
}

interface ContactImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Step = 'upload' | 'mapping' | 'progress' | 'done'

const SAMPLE_CSV_ROWS: string[][] = [
  ['이메일', '이름', '회사', '부서', '직책', '전화번호'],
  ['hong@example.com', '홍길동', '이그잼플', '영업팀', '팀장', '010-1234-5678'],
  ['jane.doe@example.com', 'Jane Doe', 'Acme Corp', 'Marketing', 'Manager', '010-2345-6789'],
  ['kim@sample.co.kr', '김민수', '샘플주식회사', '개발팀', '매니저', ''],
]

function downloadErrorsCsv(errors: ImportErrorDetail[]) {
  const escapeCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const rows = [
    ['행', '이메일', '오류'],
    ...errors.map((e) => [String(e.row), e.email, e.message]),
  ]
  const csv = rows.map((r) => r.map(escapeCell).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `mailcaster_import_errors_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function downloadSampleTemplate() {
  const csv = SAMPLE_CSV_ROWS.map((row) =>
    row.map((cell) => (cell.includes(',') ? `"${cell}"` : cell)).join(',')
  ).join('\n')
  // Excel 한글 깨짐 방지: UTF-8 BOM 추가
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'mailcaster_contacts_template.csv'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function ContactImportDialog({ open, onOpenChange }: ContactImportDialogProps) {
  const { rows, headers, progress, importing, parseFile, runImport, reset } =
    useContactImport()
  const [step, setStep] = useState<Step>('upload')
  const [dragOver, setDragOver] = useState(false)
  const [mapping, setMapping] = useState<ColumnMapping>({
    email: '',
    name: '',
    company: '',
    department: '',
    job_title: '',
    phone: '',
  })
  const [result, setResult] = useState<ImportResult | null>(null)
  const [errorsOpen, setErrorsOpen] = useState(false)

  const handleFile = useCallback(
    async (file: File) => {
      try {
        await parseFile(file)
        setStep('mapping')
      } catch (e) {
        alert(e instanceof Error ? e.message : '파일 파싱 실패')
      }
    },
    [parseFile]
  )

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleStartImport = async () => {
    if (!mapping.email) {
      alert('이메일 컬럼을 선택하세요.')
      return
    }
    setStep('progress')
    const res = await runImport(mapping)
    setResult(res)
    setStep('done')
  }

  const handleClose = () => {
    onOpenChange(false)
    setTimeout(() => {
      setStep('upload')
      setMapping({ email: '', name: '', company: '', department: '', job_title: '', phone: '' })
      setResult(null)
      setErrorsOpen(false)
      reset()
    }, 300)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 'upload' && '연락처 가져오기'}
            {step === 'mapping' && '컬럼 매핑'}
            {step === 'progress' && '가져오는 중...'}
            {step === 'done' && '가져오기 완료'}
          </DialogTitle>
        </DialogHeader>

        {/* Step 1: 파일 업로드 */}
        {step === 'upload' && (
          <div className="space-y-3">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors cursor-pointer ${
                dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
              }`}
              onClick={() => document.getElementById('import-file-input')?.click()}
            >
              <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium">CSV 또는 XLSX 파일을 드래그하거나 클릭하세요</p>
              <p className="text-xs text-muted-foreground mt-1">최대 10,000행</p>
              <input
                id="import-file-input"
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                }}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <div className="text-muted-foreground">
                <p className="font-medium text-foreground mb-0.5">처음이신가요?</p>
                <p>샘플 양식을 받아 그대로 작성 후 업로드하세요.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={downloadSampleTemplate}
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                샘플 다운로드
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: 컬럼 매핑 */}
        {step === 'mapping' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              총 {rows.length}행이 파싱되었습니다. 각 필드에 해당하는 컬럼을 선택하세요.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(FIELD_LABELS).map(([field, label]) => (
                <div key={field} className="space-y-1">
                  <Label className="text-xs">{label}</Label>
                  <Select
                    value={mapping[field] || '__none__'}
                    onValueChange={(v) =>
                      setMapping((m) => ({ ...m, [field]: v === '__none__' ? '' : v }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="선택..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— 없음 —</SelectItem>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: 진행 중 */}
        {step === 'progress' && (
          <div className="py-6 space-y-4">
            <Progress value={progress} />
            <p className="text-sm text-center text-muted-foreground">
              {progress}% 완료 ({Math.round((rows.length * progress) / 100)} / {rows.length}행)
            </p>
          </div>
        )}

        {/* Step 4: 완료 */}
        {step === 'done' && result && (
          <div className="py-4 space-y-3">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="w-5 h-5" />
              <span className="font-medium">가져오기 완료</span>
            </div>
            <div className="bg-muted rounded-lg p-4 space-y-1.5 text-sm">
              <p>전체: {result.total}행</p>
              <p className="text-green-600">처리 완료: {result.inserted}건</p>
              <p className="text-muted-foreground">건너뜀(이메일 없음/오류): {result.skipped}건</p>
            </div>
            {result.errors.length > 0 && (
              <div className="rounded-lg border border-orange-200 dark:border-orange-900/40 bg-orange-50/50 dark:bg-orange-950/20">
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setErrorsOpen((v) => !v)}
                    className="flex items-center gap-1.5 text-sm text-orange-700 dark:text-orange-400 hover:underline"
                  >
                    {errorsOpen ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                    <AlertCircle className="w-4 h-4" />
                    <span>오류 {result.errors.length}건 상세 보기</span>
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => downloadErrorsCsv(result.errors)}
                  >
                    <Download className="w-3 h-3 mr-1" />
                    CSV
                  </Button>
                </div>
                {errorsOpen && (
                  <div className="max-h-48 overflow-y-auto border-t border-orange-200 dark:border-orange-900/40">
                    <table className="w-full text-xs">
                      <thead className="bg-orange-100/60 dark:bg-orange-950/40 text-orange-800 dark:text-orange-300">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium w-12">행</th>
                          <th className="text-left px-3 py-1.5 font-medium">이메일</th>
                          <th className="text-left px-3 py-1.5 font-medium">오류</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.errors.map((e, i) => (
                          <tr
                            key={i}
                            className="border-t border-orange-200/60 dark:border-orange-900/30"
                          >
                            <td className="px-3 py-1.5 text-muted-foreground tabular-nums">
                              {e.row}
                            </td>
                            <td className="px-3 py-1.5 truncate max-w-[180px]">{e.email || '-'}</td>
                            <td className="px-3 py-1.5 text-orange-700 dark:text-orange-400">
                              {e.message}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'upload' && (
            <Button variant="outline" onClick={handleClose}>
              취소
            </Button>
          )}
          {step === 'mapping' && (
            <>
              <Button variant="outline" onClick={() => setStep('upload')}>
                이전
              </Button>
              <Button onClick={handleStartImport} disabled={!mapping.email}>
                가져오기 시작
              </Button>
            </>
          )}
          {step === 'progress' && (
            <Button variant="outline" disabled={importing}>
              {importing ? '가져오는 중...' : '완료'}
            </Button>
          )}
          {step === 'done' && (
            <Button onClick={handleClose}>닫기</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
