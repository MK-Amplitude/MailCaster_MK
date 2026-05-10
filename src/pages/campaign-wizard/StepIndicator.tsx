// 캠페인 위저드 상단 3-step 인디케이터.
// 활성 / 완료 / 미완 상태를 색상으로 구분.

import { Users, FileText, Eye, type LucideIcon } from 'lucide-react'

export type Step = 1 | 2 | 3

const STEPS: Array<{ n: Step; label: string; icon: LucideIcon }> = [
  { n: 1, label: '수신자', icon: Users },
  { n: 2, label: '내용', icon: FileText },
  { n: 3, label: '미리보기', icon: Eye },
]

export function StepIndicator({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2 mt-3">
      {STEPS.map((s, i) => {
        const Icon = s.icon
        const active = step === s.n
        const done = step > s.n
        return (
          <div key={s.n} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : done
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {s.label}
            </div>
            {i < STEPS.length - 1 && <div className="w-6 h-px bg-border" />}
          </div>
        )
      })}
    </div>
  )
}
