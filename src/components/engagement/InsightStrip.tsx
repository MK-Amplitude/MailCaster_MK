// 관계 관리 인사이트 — 한 줄 카드 그룹.
// 클릭 시 상위에서 InsightFilter 를 받아 페이지 필터에 적용.

import { AlertCircle, AlertTriangle, Sparkles, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  type Insight,
  INSIGHT_SEVERITY_STYLES,
  INSIGHT_ACCENT_TEXT,
} from '@/lib/insights'

interface Props {
  insights: Insight[]
  onClick: (insight: Insight) => void
}

const ICONS = {
  info: Info,
  warning: AlertTriangle,
  critical: AlertCircle,
  positive: Sparkles,
} as const

export function InsightStrip({ insights, onClick }: Props) {
  if (insights.length === 0) return null
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
      {insights.map((it) => {
        const Icon = ICONS[it.severity]
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onClick(it)}
            className={cn(
              'text-left rounded-lg border px-3 py-2 transition-colors',
              INSIGHT_SEVERITY_STYLES[it.severity]
            )}
          >
            <div className="flex items-start gap-2">
              <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', INSIGHT_ACCENT_TEXT[it.severity])} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span
                    className={cn(
                      'text-lg font-semibold tabular-nums',
                      INSIGHT_ACCENT_TEXT[it.severity]
                    )}
                  >
                    {it.count.toLocaleString()}
                  </span>
                  <span className="text-xs font-medium truncate">{it.label}</span>
                </div>
                {it.hint && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    {it.hint}
                  </p>
                )}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
