import type { Database } from './database.types'

export type Signature = Database['mailcaster']['Tables']['signatures']['Row']
export type SignatureInsert = Database['mailcaster']['Tables']['signatures']['Insert']
export type SignatureUpdate = Database['mailcaster']['Tables']['signatures']['Update']
