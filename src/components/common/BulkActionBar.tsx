import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'

// ============================================================
// BulkActionBar — 다중 선택 시 하단에 떠 있는 플로팅 액션 바
// ------------------------------------------------------------
// 모바일 고려사항:
//   - `bottom-6-safe` 유틸(CSS) 로 아이폰 홈바 위로 자동 회피.
//   - 버튼은 모바일에서 h-9 (≈36px) 로 확장 — 기본 터치 타겟 최소치.
//     md 부터는 기존 h-7 (≈28px) 로 복귀해 데스크톱에서 과하게 크지 않게.
//   - 가로 스크롤 가능한 flex-nowrap — 선택 개수 + 여러 액션이 길어지면
//     한 줄에 다 못 들어가는 좁은 화면(예: 360px) 에서 잘림 방지.
// ============================================================

interface BulkAction {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  variant?: 'default' | 'destructive' | 'outline'
}

interface BulkActionBarProps {
  selectedCount: number
  actions: BulkAction[]
  onClear: () => void
}

export function BulkActionBar({ selectedCount, actions, onClear }: BulkActionBarProps) {
  if (selectedCount === 0) return null

  return (
    <div className="fixed bottom-6-safe left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-1rem)]">
      <div className="flex items-center gap-2 bg-card border shadow-lg rounded-full px-3 py-2 overflow-x-auto">
        <span className="text-sm font-medium text-muted-foreground mr-1 shrink-0">
          {selectedCount}개 선택됨
        </span>
        {actions.map((action) => (
          <Button
            key={action.label}
            variant={action.variant ?? 'outline'}
            size="sm"
            onClick={action.onClick}
            className="h-9 md:h-7 text-xs rounded-full shrink-0"
          >
            {action.icon}
            {action.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          className="h-9 w-9 md:h-7 md:w-7 rounded-full shrink-0"
          aria-label="선택 해제"
        >
          <X className="w-4 h-4 md:w-3.5 md:h-3.5" />
        </Button>
      </div>
    </div>
  )
}
