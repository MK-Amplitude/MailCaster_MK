import { useMyPendingInvitations, useAcceptPendingInvitations } from '@/hooks/useOrganization'
import { Button } from '@/components/ui/button'
import { Mail } from 'lucide-react'

/**
 * 내 이메일로 온 미수락 초대가 있을 때 상단에 작게 표시.
 * 대부분은 로그인 시 자동 수락(accept_pending_invitations RPC)되지만,
 * 자동 수락이 실패했거나 로그인 세션 중 초대받은 경우 fallback 으로 보인다.
 */
export function PendingInvitesBanner() {
  const { data: invites = [] } = useMyPendingInvitations()
  const accept = useAcceptPendingInvitations()

  if (invites.length === 0) return null

  const handleAccept = () => accept.mutate()

  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-2 py-1">
      <Mail className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400" />
      <span className="text-xs text-amber-900 dark:text-amber-200">
        {invites.length}개 초대 대기 중
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={handleAccept}
        disabled={accept.isPending}
      >
        {accept.isPending ? '수락 중...' : '모두 수락'}
      </Button>
    </div>
  )
}
