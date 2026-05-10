// 관계 관리 — "캠페인별" 탭.
// 캠페인 리스트 + 발송/오픈/답장 통계. 행 클릭 → 해당 캠페인 상세 페이지로 이동.
// externalFilter (캠페인 quality) 가 들어오면 인사이트 드릴다운으로 좁혀줌.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Mail, Eye, Reply, Search, AlertOctagon, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { Badge } from '@/components/ui/badge'
import { useCampaignEngagement } from '@/hooks/useCampaignEngagement'
import { matchesSearch } from '@/lib/search'
import { cn } from '@/lib/utils'
import {
  type CampaignFilter,
  applyCampaignFilter,
  describeCampaignFilter,
  isCampaignFilterActive,
} from '@/lib/insights'

type SortKey = 'last_sent_at' | 'sent_count' | 'open_rate' | 'reply_rate'

const STATUS_LABEL: Record<string, string> = {
  draft: '초안',
  scheduled: '예약',
  sending: '발송 중',
  sent: '발송 완료',
  paused: '일시 정지',
  failed: '실패',
}

// 외부 필터 — 인사이트 클릭 시 EngagementPage 가 push.
// _v 는 같은 값 재푸시 시에도 useEffect 트리거하기 위한 nonce.
export interface CampaignTabExternalFilter extends CampaignFilter {
  _v?: number
  _replace?: boolean
}

interface Props {
  highlightCampaignId?: string | null
  externalFilter?: CampaignTabExternalFilter
  onClearExternal?: () => void
}

export function CampaignTab({
  highlightCampaignId,
  externalFilter,
  onClearExternal,
}: Props) {
  const navigate = useNavigate()
  const { data: campaigns = [], isLoading } = useCampaignEngagement()

  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('last_sent_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [activeFilter, setActiveFilter] = useState<CampaignFilter>({})

  // 외부 필터 적용
  useEffect(() => {
    if (!externalFilter) return
    if (externalFilter._replace) {
      setActiveFilter({
        lowOpenRate: externalFilter.lowOpenRate,
        highOpenRate: externalFilter.highOpenRate,
        noReply: externalFilter.noReply,
        highReplyRate: externalFilter.highReplyRate,
        highBounce: externalFilter.highBounce,
        recentlySent: externalFilter.recentlySent,
      })
    } else {
      setActiveFilter((prev) => ({ ...prev, ...externalFilter }))
    }
  }, [externalFilter])

  const filtered = useMemo(() => {
    const q = search.trim()
    const byQuality = applyCampaignFilter(campaigns, activeFilter)
    return byQuality.filter((c) => {
      if (c.sent_count === 0 && c.status !== 'sent') return false
      if (q) return matchesSearch(c.name, q) || matchesSearch(c.subject, q)
      return true
    })
  }, [campaigns, search, activeFilter])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av =
        sortKey === 'last_sent_at'
          ? a.last_sent_at
            ? new Date(a.last_sent_at).getTime()
            : 0
          : (a[sortKey] as number) || 0
      const bv =
        sortKey === 'last_sent_at'
          ? b.last_sent_at
            ? new Date(b.last_sent_at).getTime()
            : 0
          : (b[sortKey] as number) || 0
      return (av - bv) * dir
    })
  }, [filtered, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const filterActive = isCampaignFilterActive(activeFilter)
  const filterLabel = filterActive ? describeCampaignFilter(activeFilter) : ''
  const clearFilter = () => {
    setActiveFilter({})
    onClearExternal?.()
  }

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 필터 바 */}
      <div className="px-4 sm:px-6 py-3 border-b">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="캠페인명 / 제목 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {filterActive && (
            <Badge
              variant="outline"
              className="h-7 text-xs gap-1.5 cursor-pointer"
              onClick={clearFilter}
              title={filterLabel}
            >
              {filterLabel} ✕
            </Badge>
          )}
          {filterActive && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearFilter}>
              필터 초기화
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground tabular-nums">
            {sorted.length.toLocaleString()}건
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <EmptyState
            icon={Mail}
            title={filterActive ? '조건에 맞는 캠페인이 없습니다' : '발송된 캠페인이 없습니다'}
            description={
              filterActive
                ? '필터를 조정하거나 초기화해보세요.'
                : '캠페인을 만들고 발송해야 여기에 통계가 쌓입니다.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>캠페인</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>
                  <SortBtn
                    active={sortKey === 'last_sent_at'}
                    dir={sortDir}
                    onClick={() => toggleSort('last_sent_at')}
                  >
                    마지막 발송
                  </SortBtn>
                </TableHead>
                <TableHead>
                  <SortBtn
                    active={sortKey === 'sent_count'}
                    dir={sortDir}
                    onClick={() => toggleSort('sent_count')}
                  >
                    발송수
                  </SortBtn>
                </TableHead>
                <TableHead>
                  <SortBtn
                    active={sortKey === 'open_rate'}
                    dir={sortDir}
                    onClick={() => toggleSort('open_rate')}
                  >
                    오픈율
                  </SortBtn>
                </TableHead>
                <TableHead>
                  <SortBtn
                    active={sortKey === 'reply_rate'}
                    dir={sortDir}
                    onClick={() => toggleSort('reply_rate')}
                  >
                    답장률
                  </SortBtn>
                </TableHead>
                <TableHead className="hidden md:table-cell">반송</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((c) => (
                <TableRow
                  key={c.id}
                  className={cn(
                    'cursor-pointer hover:bg-muted/30',
                    highlightCampaignId === c.id && 'bg-primary/5'
                  )}
                  onClick={() => navigate(`/campaigns/${c.id}`)}
                >
                  <TableCell className="max-w-[260px]">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium truncate">{c.name}</span>
                      {c.subject && (
                        <span className="text-[11px] text-muted-foreground truncate">
                          {c.subject}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4">
                      {STATUS_LABEL[c.status] ?? c.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className="text-xs text-muted-foreground"
                      title={
                        c.last_sent_at
                          ? format(new Date(c.last_sent_at), 'yyyy-MM-dd HH:mm')
                          : undefined
                      }
                    >
                      {c.last_sent_at
                        ? formatDistanceToNow(new Date(c.last_sent_at), {
                            addSuffix: true,
                            locale: ko,
                          })
                        : '미발송'}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {c.sent_count.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Eye className="w-3 h-3 text-muted-foreground" />
                      {c.open_rate}%
                      <span className="text-[10px] text-muted-foreground">
                        ({c.unique_opens})
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Reply className="w-3 h-3 text-muted-foreground" />
                      {c.reply_rate}%
                      <span className="text-[10px] text-muted-foreground">
                        ({c.reply_count})
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm tabular-nums">
                    {c.bounce_count > 0 ? (
                      <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                        <AlertOctagon className="w-3 h-3" />
                        {c.bounce_count}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

function SortBtn({
  active,
  dir,
  onClick,
  children,
}: {
  active: boolean
  dir: 'asc' | 'desc'
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-0.5 hover:text-foreground transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {children}
      <span className={active ? 'opacity-100' : 'opacity-40'}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </button>
  )
}
