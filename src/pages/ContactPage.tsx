// Contact 단건 풀페이지 — /contacts/:id
//
// ContactDetailSheet 는 옆에서 슬라이드 형식이라 메일 작성 / history 깊이 보기엔 좁다.
// 이 페이지는 북마크 / 공유 가능한 본격 작업 화면 — Contact 한 명 중심의 모든 정보 + 메일 흐름.

import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useContactById } from '@/hooks/useContacts'
import { ContactDetailSheet } from '@/components/contacts/ContactDetailSheet'
import { ContactFormDialog } from '@/components/contacts/ContactFormDialog'
import { useToggleUnsubscribe } from '@/hooks/useContacts'
import { Loader2, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ContactWithGroups } from '@/types/contact'

export default function ContactPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: contact, isLoading, isError } = useContactById(id)
  const toggleUnsubscribe = useToggleUnsubscribe()
  const [editTarget, setEditTarget] = useState<ContactWithGroups | null>(null)

  // ContactDetailSheet 는 "옆에서 슬라이드" 라 페이지 안에서 항상 열어둠.
  // 이 페이지 자체가 sheet container 역할 — sheet 닫기 동작은 contacts 페이지로 이동.
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (!open) navigate('/contacts')
  }, [open, navigate])

  if (!id) return <Navigate to="/contacts" replace />
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (isError || !contact) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto">
        <Button variant="ghost" size="sm" onClick={() => navigate('/contacts')}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          연락처 목록
        </Button>
        <div className="text-center text-sm text-muted-foreground py-16">
          연락처를 찾을 수 없습니다.
        </div>
      </div>
    )
  }

  return (
    <>
      <ContactDetailSheet
        contact={contact}
        open={open}
        onOpenChange={setOpen}
        onEdit={(c) => setEditTarget(c)}
        onToggleUnsubscribe={(c) =>
          toggleUnsubscribe.mutate({
            id: c.id,
            unsubscribe: !c.is_unsubscribed,
          })
        }
      />
      <ContactFormDialog
        open={!!editTarget}
        onOpenChange={(v) => {
          if (!v) setEditTarget(null)
        }}
        contact={editTarget}
      />
    </>
  )
}
