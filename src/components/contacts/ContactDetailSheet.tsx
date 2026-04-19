import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Pencil, UserX, UserCheck, Building2, Phone, Clock, FileText, Sparkles, User, History } from 'lucide-react'
import type { ContactWithGroups } from '@/types/contact'
import { formatDateTime } from '@/lib/utils'
import { useContactHistory } from '@/hooks/useContactHistory'
import type { ContactHistoryRow } from '@/hooks/useContactHistory'

interface ContactDetailSheetProps {
  contact: ContactWithGroups | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: (contact: ContactWithGroups) => void
  onToggleUnsubscribe: (contact: ContactWithGroups) => void
}

export function ContactDetailSheet({
  contact,
  open,
  onOpenChange,
  onEdit,
  onToggleUnsubscribe,
}: ContactDetailSheetProps) {
  const { data: history = [] } = useContactHistory(contact?.id)

  if (!contact) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-5 py-4 border-b">
          <SheetTitle className="text-left">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">
                    {contact.name ?? '이름 없음'}
                  </span>
                  <StatusBadge
                    isUnsubscribed={contact.is_unsubscribed}
                    isBounced={contact.is_bounced}
                  />
                </div>
                <p className="text-sm text-muted-foreground font-normal mt-0.5">
                  {contact.email}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onEdit(contact)}
                >
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onToggleUnsubscribe(contact)}
                >
                  {contact.is_unsubscribed ? (
                    <UserCheck className="w-4 h-4" />
                  ) : (
                    <UserX className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-5">
            {/* 기본 정보 */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                기본 정보
              </h3>
              {contact.company && (
                <InfoRow icon={Building2} label="회사 (입력값)">
                  <span>{contact.company}</span>
                  {contact.department && (
                    <span className="text-muted-foreground"> · {contact.department}</span>
                  )}
                </InfoRow>
              )}
              {(contact.company_ko || contact.company_en) && (
                <InfoRow icon={Sparkles} label="공식 명칭 (AI)">
                  <div className="space-y-0.5">
                    {contact.company_ko && (
                      <div>
                        <span className="text-[10px] text-muted-foreground mr-1">KO</span>
                        {contact.company_ko}
                      </div>
                    )}
                    {contact.company_en && (
                      <div>
                        <span className="text-[10px] text-muted-foreground mr-1">EN</span>
                        {contact.company_en}
                      </div>
                    )}
                  </div>
                </InfoRow>
              )}
              {contact.job_title && (
                <InfoRow icon={FileText} label="직책">
                  {contact.job_title}
                </InfoRow>
              )}
              {contact.phone && (
                <InfoRow icon={Phone} label="전화">
                  {contact.phone}
                </InfoRow>
              )}
              <InfoRow icon={Clock} label="등록일">
                {formatDateTime(contact.created_at)}
              </InfoRow>
              {(contact.owner_name || contact.owner_email) && (
                <InfoRow icon={User} label="소유자">
                  <div>
                    {contact.owner_name ?? contact.owner_email}
                    {contact.owner_name && contact.owner_email && (
                      <span className="text-xs text-muted-foreground ml-1">
                        ({contact.owner_email})
                      </span>
                    )}
                  </div>
                </InfoRow>
              )}
            </section>

            <Separator />

            {/* 소속 그룹 */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                소속 그룹
              </h3>
              {contact.groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">소속 그룹 없음</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {contact.groups.map((g) => (
                    <Badge
                      key={g.group_id}
                      variant="outline"
                      className="text-xs"
                      style={
                        g.category_color
                          ? { borderColor: g.category_color, color: g.category_color }
                          : undefined
                      }
                    >
                      {g.category_name && (
                        <span className="opacity-60 mr-1">{g.category_name} /</span>
                      )}
                      {g.group_name}
                    </Badge>
                  ))}
                </div>
              )}
            </section>

            {/* 메모 */}
            {contact.memo && (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    메모
                  </h3>
                  <p className="text-sm whitespace-pre-wrap">{contact.memo}</p>
                </section>
              </>
            )}

            {/* 커스텀 변수 */}
            {contact.variables && Object.keys(contact.variables as object).length > 0 && (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    커스텀 변수
                  </h3>
                  <div className="space-y-1.5">
                    {Object.entries(contact.variables as Record<string, string>).map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-sm">
                        <span className="font-medium min-w-[80px] text-muted-foreground">
                          {k}
                        </span>
                        <span>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {/* 변경 이력 */}
            {history.length > 0 && (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                    <History className="w-3 h-3" />
                    변경 이력
                  </h3>
                  <div className="space-y-2">
                    {history.map((h) => (
                      <HistoryEntry key={h.id} row={h} />
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ElementType
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
      <div>
        <span className="text-muted-foreground text-xs block">{label}</span>
        <div className="text-foreground">{children}</div>
      </div>
    </div>
  )
}

const FIELD_LABELS: Record<string, string> = {
  email: '이메일',
  name: '이름',
  company: '회사',
  company_raw: '회사(원본)',
  company_ko: '회사(한글)',
  company_en: '회사(영문)',
  department: '부서',
  job_title: '직책',
  phone: '전화번호',
  memo: '메모',
}

function HistoryEntry({ row }: { row: ContactHistoryRow }) {
  const snapshot = row.snapshot as Record<string, unknown>
  return (
    <div className="rounded border p-2.5 text-xs bg-muted/30">
      <div className="flex items-center justify-between mb-1.5">
        <Badge
          variant="secondary"
          className="text-[10px] py-0 px-1.5"
        >
          {row.action === 'create' ? '생성' : '수정'}
        </Badge>
        <span className="text-muted-foreground">{formatDateTime(row.changed_at)}</span>
      </div>
      {row.action === 'update' && row.changed_fields.length > 0 && (
        <div className="space-y-0.5">
          {row.changed_fields.map((field) => {
            const oldValue = snapshot[field]
            const label = FIELD_LABELS[field] ?? field
            return (
              <div key={field} className="flex gap-1.5">
                <span className="text-muted-foreground min-w-[60px]">{label}</span>
                <span className="line-through text-muted-foreground truncate">
                  {oldValue == null || oldValue === '' ? '-' : String(oldValue)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
