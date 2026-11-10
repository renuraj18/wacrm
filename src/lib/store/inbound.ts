// ============================================================
// Entry point for the store on an incoming customer message. Returns true
// when the store answered (so automations skip it), false otherwise. Off
// unless the account has store_enabled (migration 070).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { connectionGraphql } from '@/lib/shopify/client'
import { loadConnection } from '@/lib/shopify/sync'
import { routeStore, type StoreDeps } from './handler'
import { sendStoreReply } from './send'
import { loadCart, saveCart } from './storage'

const DEFAULT_STORE_COLLECTIONS = 'kolam-sarees,elephant-saree,kanchi-pattu,kanchi-semi-silk,kalyani,banaras-warm-silk,kanchi-checks'

export interface StoreInbound {
  db: SupabaseClient
  accountId: string
  conversationId: string
  phone: string
  accessToken: string
  text: string
  /** Button or list reply id, when the customer tapped one. */
  interactiveReplyId: string | null
}

export async function handleStoreInbound(args: StoreInbound): Promise<boolean> {
  const { data: cfg } = await args.db
    .from('shopify_config')
    .select('store_enabled')
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (!(cfg as { store_enabled?: boolean } | null)?.store_enabled) return false

  const conn = await loadConnection(args.db, args.accountId)
  if (!conn) return false

  const { data: wa } = await args.db
    .from('whatsapp_config')
    .select('phone_number_id')
    .eq('account_id', args.accountId)
    .maybeSingle()
  const phoneNumberId = (wa as { phone_number_id?: string } | null)?.phone_number_id
  if (!phoneNumberId) return false

  const deps: StoreDeps = {
    cacheScope: args.accountId,
    run: await connectionGraphql(args.db, conn),
    shopUrl: process.env.STORE_SHOP_URL || 'https://shanthiboutique.com',
    storeOrder: (process.env.STORE_COLLECTIONS || DEFAULT_STORE_COLLECTIONS)
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    loadCart: (phone) => loadCart(args.db, args.accountId, phone),
    saveCart: (phone, items) => saveCart(args.db, args.accountId, phone, items),
  }

  const replies = await routeStore(deps, {
    phone: args.phone,
    text: args.text,
    buttonId: args.interactiveReplyId,
  })
  if (!replies) return false

  const ctx = {
    db: args.db,
    accountId: args.accountId,
    conversationId: args.conversationId,
    phone: args.phone,
    phoneNumberId,
    accessToken: args.accessToken,
  }
  for (const reply of replies) {
    await sendStoreReply(ctx, reply)
  }
  return true
}
