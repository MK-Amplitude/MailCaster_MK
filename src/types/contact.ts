import type { Database } from './database.types'

export type Contact = Database['mailcaster']['Tables']['contacts']['Row']
export type ContactInsert = Database['mailcaster']['Tables']['contacts']['Insert']
export type ContactUpdate = Database['mailcaster']['Tables']['contacts']['Update']

type ContactView = Database['mailcaster']['Views']['contact_with_groups']['Row']

export interface ContactWithGroups extends Omit<ContactView, 'groups'> {
  groups: ContactGroupInfo[]
}

export interface ContactGroupInfo {
  group_id: string
  group_name: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
}

export type ContactStatus =
  | 'all'
  | 'normal'
  | 'unsubscribed'
  | 'bounced'
  | 'no_group'
  | 'needs_verification' // company_lookup_status ∈ {pending, failed, not_found}

export interface ContactFilters {
  search?: string
  groupIds?: string[]
  status?: ContactStatus
}
