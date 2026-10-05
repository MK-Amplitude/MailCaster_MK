// 발송 확인 다이얼로그 — ConfirmDialog 와 같은 모양에 발송 전 경고(프리플라이트) 목록을 더한 것.
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

interface SendConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  warnings: string[]
  confirmLabel: string
  loading?: boolean
  onConfirm: () => void
}

export function SendConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  warnings,
  confirmLabel,
  loading = false,
  onConfirm,
}: SendConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {warnings.length > 0 && (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto">
            {warnings.map((w) => (
              <li
                key={w}
                className="flex items-start gap-1.5 text-xs rounded p-2 bg-amber-50/70 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="break-words min-w-0">{w}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            취소
          </Button>
          <Button onClick={onConfirm} disabled={loading}>
            {loading ? '처리 중...' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
