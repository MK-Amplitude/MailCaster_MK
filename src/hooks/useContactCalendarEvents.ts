// 연락처의 이메일이 attendee/organizer 로 포함된 Google Calendar 이벤트.
// ContactTimeline 에 미팅을 인입.

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export interface CalendarEvent {
  id: string
  summary: string | null
  start_at: string | null
  end_at: string | null
  hangout_link: string | null
  html_link: string | null
  attendees_count: number
  organizer_email: string | null
  status: string | null
}

export interface CalendarEventsResult {
  events: CalendarEvent[]
  /** Calendar 권한 미부여 — 사용자에게 재로그인 안내 */
  scope_missing?: boolean
}

const QK = 'contact-calendar-events'

export function useContactCalendarEvents(contactEmail: string | null | undefined) {
  return useQuery({
    queryKey: [QK, contactEmail],
    queryFn: async (): Promise<CalendarEventsResult> => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const { data, error } = await supabase.functions.invoke('fetch-calendar-events', {
        body: { contact_email: contactEmail },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) {
        // 일반 오류는 throw — 권한 없음 (scope_missing) 은 본문으로 와야 함
        throw new Error(error.message || 'Calendar 이벤트 조회 실패')
      }
      return data as CalendarEventsResult
    },
    enabled: !!contactEmail,
    // Calendar 데이터는 자주 안 변함 — 5분 캐시
    staleTime: 1000 * 60 * 5,
  })
}
