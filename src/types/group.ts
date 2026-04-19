import type { Database } from './database.types'

export type GroupCategory = Database['mailcaster']['Tables']['group_categories']['Row']
export type GroupCategoryInsert = Database['mailcaster']['Tables']['group_categories']['Insert']
export type GroupCategoryUpdate = Database['mailcaster']['Tables']['group_categories']['Update']

export type Group = Database['mailcaster']['Tables']['groups']['Row']
export type GroupInsert = Database['mailcaster']['Tables']['groups']['Insert']
export type GroupUpdate = Database['mailcaster']['Tables']['groups']['Update']

export type ContactGroup = Database['mailcaster']['Tables']['contact_groups']['Row']

export interface GroupWithCategory extends Group {
  category: GroupCategory | null
}
