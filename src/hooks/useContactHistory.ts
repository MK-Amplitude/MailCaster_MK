import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/database.types'

export type ContactHistoryRow = Database['mailcaster']['Tables']['contact_history']['Row']

export function useContactHistory(contactId: string | undefined) {
  return useQuery({
    queryKey: ['contact-history', contactId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contact_history')
        .select('*')
        .eq('contact_id', contactId!)
        .order('changed_at', { ascending: false })
        .limit(50)
      if (error) throw error
      return (data ?? []) as ContactHistoryRow[]
    },
    enabled: !!contactId,
  })
}
