import { useState, useMemo } from 'react'
import { matchesSearch } from '@/lib/search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ContactsTable } from '@/components/contacts/ContactsTable'
import { ContactFormDialog } from '@/components/contacts/ContactFormDialog'
import { ContactDetailSheet } from '@/components/contacts/ContactDetailSheet'
import { ContactImportDialog } from '@/components/contacts/ContactImportDialog'
import { AddToGroupDialog } from '@/components/contacts/AddToGroupDialog'
import { BulkActionBar } from '@/components/common/BulkActionBar'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import {
  useContacts,
  useDeleteContacts,
  useToggleUnsubscribe,
} from '@/hooks/useContacts'
import { UserPlus, Upload, Users, Search, UserX, Trash2, FolderPlus } from 'lucide-react'
import type { ContactWithGroups, ContactStatus } from '@/types/contact'

export default function ContactsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ContactStatus>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [formOpen, setFormOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editContact, setEditContact] = useState<ContactWithGroups | null>(null)
  const [detailContact, setDetailContact] = useState<ContactWithGroups | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ContactWithGroups | null>(null)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [addToGroupOpen, setAddToGroupOpen] = useState(false)

  const { data: allContacts = [], isLoading } = useContacts({ groupIds: [], status })

  const contacts = useMemo(() => {
    const q = search.trim()
    if (!q) return allContacts
    return allContacts.filter(
      (c) =>
        matchesSearch(c.name, q) ||
        matchesSearch(c.email, q) ||
        matchesSearch(c.company, q) ||
        matchesSearch(c.department, q) ||
        matchesSearch(c.job_title, q)
    )
  }, [allContacts, search])
  const deleteContacts = useDeleteContacts()
  const toggleUnsub = useToggleUnsubscribe()

  const handleSelectId = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const handleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(contacts.map((c) => c.id)) : new Set())
  }

  const handleEdit = (contact: ContactWithGroups) => {
    setEditContact(contact)
    setFormOpen(true)
    setDetailContact(null)
  }

  const handleRowClick = (contact: ContactWithGroups) => {
    setDetailContact(contact)
  }

  const handleDelete = async () => {
    if (deleteTarget) {
      await deleteContacts.mutateAsync([deleteTarget.id])
      setDeleteTarget(null)
    }
  }

  const handleBulkDelete = async () => {
    await deleteContacts.mutateAsync([...selectedIds])
    setSelectedIds(new Set())
    setBulkDeleteOpen(false)
  }

  const handleToggleUnsub = (contact: ContactWithGroups) => {
    toggleUnsub.mutate({ id: contact.id, unsubscribe: !contact.is_unsubscribed })
  }

  const openNewForm = () => {
    setEditContact(null)
    setFormOpen(true)
  }

  return (
    <div className="flex flex-col h-full">
      {/* 헤더 */}
      <div className="px-4 sm:px-6 py-4 border-b">
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">연락처</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              총 {contacts.length}명
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="w-4 h-4 sm:mr-1.5" />
              <span className="hidden sm:inline">가져오기</span>
            </Button>
            <Button size="sm" onClick={openNewForm}>
              <UserPlus className="w-4 h-4 sm:mr-1.5" />
              <span className="hidden sm:inline">연락처 추가</span>
            </Button>
          </div>
        </div>

        {/* 필터 */}
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="이름/이메일/회사/부서/직책 검색 (초성 가능: ㄱㄷ)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as ContactStatus)}>
            <SelectTrigger className="h-8 w-36 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체</SelectItem>
              <SelectItem value="normal">정상만</SelectItem>
              <SelectItem value="unsubscribed">수신거부</SelectItem>
              <SelectItem value="bounced">바운스</SelectItem>
              <SelectItem value="needs_verification">⚠️ 회사 확인 필요</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 테이블 */}
      <div className="flex-1 overflow-auto">
        {!isLoading && contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="연락처가 없습니다"
            description="연락처를 추가하거나 CSV/XLSX 파일로 가져오세요."
            action={{ label: '연락처 추가', onClick: openNewForm }}
          />
        ) : (
          <ContactsTable
            contacts={contacts}
            loading={isLoading}
            selectedIds={selectedIds}
            onSelectId={handleSelectId}
            onSelectAll={handleSelectAll}
            onEdit={handleEdit}
            onDelete={(c) => setDeleteTarget(c)}
            onToggleUnsubscribe={handleToggleUnsub}
            onRowClick={handleRowClick}
          />
        )}
      </div>

      {/* 벌크 액션 바 */}
      <BulkActionBar
        selectedCount={selectedIds.size}
        onClear={() => setSelectedIds(new Set())}
        actions={[
          {
            label: '그룹에 추가',
            icon: <FolderPlus className="w-3.5 h-3.5 mr-1" />,
            onClick: () => setAddToGroupOpen(true),
          },
          {
            label: '수신거부',
            icon: <UserX className="w-3.5 h-3.5 mr-1" />,
            onClick: () => {
              const ids = [...selectedIds]
              ids.forEach((id) => {
                const c = contacts.find((x) => x.id === id)
                if (c && !c.is_unsubscribed) {
                  toggleUnsub.mutate({ id, unsubscribe: true })
                }
              })
              setSelectedIds(new Set())
            },
          },
          {
            label: '삭제',
            icon: <Trash2 className="w-3.5 h-3.5 mr-1" />,
            variant: 'destructive',
            onClick: () => setBulkDeleteOpen(true),
          },
        ]}
      />

      {/* 다이얼로그들 */}
      <ContactFormDialog
        open={formOpen}
        onOpenChange={(v) => { setFormOpen(v); if (!v) setEditContact(null) }}
        contact={editContact}
      />
      <ContactImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <AddToGroupDialog
        open={addToGroupOpen}
        onOpenChange={setAddToGroupOpen}
        contactIds={[...selectedIds]}
        onDone={() => setSelectedIds(new Set())}
      />
      <ContactDetailSheet
        contact={detailContact}
        open={!!detailContact}
        onOpenChange={(v) => !v && setDetailContact(null)}
        onEdit={handleEdit}
        onToggleUnsubscribe={handleToggleUnsub}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="연락처 삭제"
        description={`"${deleteTarget?.name ?? deleteTarget?.email}"을(를) 삭제하시겠습니까?`}
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleteContacts.isPending}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`연락처 ${selectedIds.size}개 삭제`}
        description="선택한 연락처를 모두 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다."
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={handleBulkDelete}
        loading={deleteContacts.isPending}
      />
    </div>
  )
}
