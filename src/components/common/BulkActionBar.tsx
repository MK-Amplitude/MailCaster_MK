import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'

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
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
      <div className="flex items-center gap-2 bg-card border shadow-lg rounded-full px-4 py-2">
        <span className="text-sm font-medium text-muted-foreground mr-1">
          {selectedCount}개 선택됨
        </span>
        {actions.map((action) => (
          <Button
            key={action.label}
            variant={action.variant ?? 'outline'}
            size="sm"
            onClick={action.onClick}
            className="h-7 text-xs rounded-full"
          >
            {action.icon}
            {action.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          className="h-7 w-7 rounded-full"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}
