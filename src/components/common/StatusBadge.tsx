import { Badge } from '@/components/ui/badge'

interface StatusBadgeProps {
  isUnsubscribed: boolean
  isBounced: boolean
}

export function StatusBadge({ isUnsubscribed, isBounced }: StatusBadgeProps) {
  if (isUnsubscribed) {
    return (
      <Badge variant="destructive" className="text-xs">
        🚫 수신거부
      </Badge>
    )
  }
  if (isBounced) {
    return (
      <Badge className="text-xs bg-orange-100 text-orange-700 border-orange-200 hover:bg-orange-100">
        🪃 바운스
      </Badge>
    )
  }
  return null
}
