// 메일 본문/제목에 변수 키를 삽입하는 드롭다운.
// TipTap editor 또는 input 의 onInsert 로 캐럿 위치에 {{key}} 삽입.

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Braces } from 'lucide-react'
import { TEMPLATE_VARIABLES } from '@/types/template'

export function VariableDropdown({ onInsert }: { onInsert: (key: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs">
          <Braces className="w-3.5 h-3.5 mr-1" />
          변수 삽입
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {TEMPLATE_VARIABLES.map((v) => (
          <DropdownMenuItem key={v.key} onClick={() => onInsert(v.key)} className="text-xs">
            <span className="font-medium">{`{{${v.key}}}`}</span>
            <span className="ml-auto text-muted-foreground">{v.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
