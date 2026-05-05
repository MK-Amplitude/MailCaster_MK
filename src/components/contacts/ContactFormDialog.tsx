import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCreateContact, useUpdateContact, useParentGroupOptions } from '@/hooks/useContacts'
import { resolveCompanyForContact } from '@/lib/resolveCompany'
import { useQueryClient } from '@tanstack/react-query'
import { Sparkles, Loader2 } from 'lucide-react'
import { CUSTOMER_TYPE_OPTIONS, type Contact, type CustomerType } from '@/types/contact'

const schema = z.object({
  email: z.string().email('올바른 이메일 형식을 입력하세요.'),
  name: z.string().optional(),
  company: z.string().optional(),
  department: z.string().optional(),
  job_title: z.string().optional(),
  phone: z.string().optional(),
  memo: z.string().optional(),
  // 폼 입력 시점에는 optional (default 'general' 적용), submit 후에는 보장됨.
  customer_type: z.enum(['amplitude_customer', 'prospect', 'general']).optional(),
  // 그룹사 — 자유 입력. 빈 문자열은 저장 시 null 로 변환.
  parent_group: z.string().optional(),
})

type FormData = z.infer<typeof schema>

interface ContactFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contact?: Contact | null
}

export function ContactFormDialog({ open, onOpenChange, contact }: ContactFormDialogProps) {
  const isEdit = !!contact
  const create = useCreateContact()
  const update = useUpdateContact()
  const qc = useQueryClient()
  const [resolving, setResolving] = useState(false)
  // 그룹사 자동완성용 — 기존 데이터에 있는 그룹사 목록
  const { data: parentGroupOptions = [] } = useParentGroupOptions()

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { customer_type: 'general' },
  })

  useEffect(() => {
    if (open) {
      reset(
        contact
          ? {
              email: contact.email,
              name: contact.name ?? '',
              company: contact.company ?? '',
              department: contact.department ?? '',
              job_title: contact.job_title ?? '',
              phone: contact.phone ?? '',
              memo: contact.memo ?? '',
              customer_type: (contact.customer_type as CustomerType | null) ?? 'general',
              parent_group: contact.parent_group ?? '',
            }
          : { customer_type: 'general', parent_group: '' }
      )
    }
  }, [open, contact, reset])

  const onSubmit = async (data: FormData) => {
    // 빈 문자열 → null 정규화 (특히 parent_group 은 NULL 의미가 명확해야 함)
    const payload = {
      ...data,
      parent_group: data.parent_group?.trim() ? data.parent_group.trim() : null,
    }
    if (isEdit && contact) {
      await update.mutateAsync({ id: contact.id, data: payload })
    } else {
      await create.mutateAsync(payload)
    }
    onOpenChange(false)
  }

  const isPending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? '연락처 수정' : '연락처 추가'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">이메일 *</Label>
            <Input
              id="email"
              type="email"
              placeholder="name@company.com"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              {...register('email')}
              disabled={isEdit}
            />
            {errors.email && (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="name">이름</Label>
              <Input id="name" placeholder="홍길동" {...register('name')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">전화번호</Label>
              <Input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="010-0000-0000"
                {...register('phone')}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="company">회사 (입력값)</Label>
            <Input id="company" placeholder="주식회사 예시" {...register('company')} />
            {isEdit && contact && (
              <CompanyResolvedInfo
                contact={contact}
                resolving={resolving}
                onReresolve={async () => {
                  if (!contact.company) return
                  setResolving(true)
                  try {
                    await resolveCompanyForContact({
                      rawName: contact.company,
                      contactId: contact.id,
                      qc,
                    })
                  } finally {
                    setResolving(false)
                  }
                }}
              />
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="department">부서</Label>
              <Input id="department" placeholder="마케팅팀" {...register('department')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="job_title">직책</Label>
              <Input id="job_title" placeholder="팀장" {...register('job_title')} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="customer_type">고객 분류</Label>
              <Controller
                control={control}
                name="customer_type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={(v) => field.onChange(v as CustomerType)}>
                    <SelectTrigger id="customer_type" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CUSTOMER_TYPE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="parent_group">그룹사</Label>
              <Input
                id="parent_group"
                list="contact-form-parent-groups"
                placeholder="롯데, 카카오, ... (선택 또는 입력)"
                autoComplete="off"
                {...register('parent_group')}
              />
              <datalist id="contact-form-parent-groups">
                {parentGroupOptions.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground -mt-2">
            메일 그룹 발송 시 분류/그룹사별로 따로 보낼 수 있어요. AI 가 회사명 분석 후 자동 채워주지만 수동 수정도 가능합니다.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="memo">메모</Label>
            <Textarea
              id="memo"
              placeholder="참고 사항..."
              rows={3}
              {...register('memo')}
              className="resize-none"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              취소
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? '저장 중...' : isEdit ? '수정' : '추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CompanyResolvedInfo({
  contact,
  resolving,
  onReresolve,
}: {
  contact: Contact
  resolving: boolean
  onReresolve: () => void
}) {
  const status = contact.company_lookup_status
  const hasResolved = contact.company_ko || contact.company_en

  return (
    <div className="mt-1.5 p-2.5 rounded border bg-muted/30 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="w-3 h-3" />
          AI 공식명 조회
          {status === 'pending' && (
            <Badge variant="secondary" className="text-[10px] py-0 px-1.5">대기</Badge>
          )}
          {status === 'resolved' && (
            <Badge variant="secondary" className="text-[10px] py-0 px-1.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">완료</Badge>
          )}
          {status === 'not_found' && (
            <Badge variant="secondary" className="text-[10px] py-0 px-1.5">미매칭</Badge>
          )}
          {status === 'failed' && (
            <Badge variant="secondary" className="text-[10px] py-0 px-1.5 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">실패</Badge>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={onReresolve}
          disabled={resolving || !contact.company}
        >
          {resolving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
          다시 조회
        </Button>
      </div>
      {hasResolved ? (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground text-[10px]">한글</div>
            <div className="font-medium">{contact.company_ko ?? '-'}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[10px]">영문</div>
            <div className="font-medium">{contact.company_en ?? '-'}</div>
          </div>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          {status === 'pending' ? '조회 대기 중입니다...' : '매칭된 공식명이 없습니다.'}
        </div>
      )}
    </div>
  )
}
