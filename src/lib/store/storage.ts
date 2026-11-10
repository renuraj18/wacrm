// ============================================================
// Store storage: carts (one per customer phone) and WhatsApp media ids for
// card photos. Service-role access only (tables from migrations 068 and 069).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { CartLine } from './cart'

/** Carts unused for this long are ignored (the table keeps them until cleaned up). */
export const CART_TTL_DAYS = 30
/** WhatsApp media ids expire; re-upload after this many days. */
export const MEDIA_TTL_DAYS = 30

export function isCartLine(v: unknown): v is CartLine {
  if (!v || typeof v !== 'object') return false
  const l = v as Record<string, unknown>
  return (
    typeof l.variantId === 'string' &&
    typeof l.productTitle === 'string' &&
    typeof l.variantTitle === 'string' &&
    typeof l.price === 'number' &&
    typeof l.quantity === 'number'
  )
}

export async function loadCart(db: SupabaseClient, accountId: string, phone: string): Promise<CartLine[]> {
  const { data, error } = await db
    .from('shopify_store_carts')
    .select('items, updated_at')
    .eq('account_id', accountId)
    .eq('phone', phone)
    .maybeSingle()
  if (error) throw error
  if (!data) return []
  const age = Date.now() - new Date((data as { updated_at: string }).updated_at).getTime()
  if (age > CART_TTL_DAYS * 86_400_000) return []
  const items = (data as { items: unknown }).items
  return Array.isArray(items) ? items.filter(isCartLine) : []
}

export async function saveCart(db: SupabaseClient, accountId: string, phone: string, items: CartLine[]): Promise<void> {
  const { error } = await db.from('shopify_store_carts').upsert(
    { account_id: accountId, phone, items, updated_at: new Date().toISOString() },
    { onConflict: 'account_id,phone' },
  )
  if (error) throw error
}

/** Photo url → WhatsApp media id, for photos WhatsApp already has. */
export async function cachedMediaIds(db: SupabaseClient, accountId: string, urls: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!urls.length) return map
  const since = new Date(Date.now() - MEDIA_TTL_DAYS * 86_400_000).toISOString()
  const { data, error } = await db
    .from('whatsapp_media_cache')
    .select('photo_url, media_id')
    .eq('account_id', accountId)
    .in('photo_url', urls)
    .gte('created_at', since)
  if (error) throw error
  for (const row of (data ?? []) as { photo_url: string; media_id: string }[]) {
    map.set(row.photo_url, row.media_id)
  }
  return map
}

export async function rememberMediaIds(
  db: SupabaseClient,
  accountId: string,
  entries: { url: string; mediaId: string }[],
): Promise<void> {
  if (!entries.length) return
  const { error } = await db.from('whatsapp_media_cache').upsert(
    entries.map((e) => ({ account_id: accountId, photo_url: e.url, media_id: e.mediaId, created_at: new Date().toISOString() })),
    { onConflict: 'account_id,photo_url' },
  )
  if (error) throw error
}

export async function forgetMediaIds(db: SupabaseClient, accountId: string, urls: string[]): Promise<void> {
  if (!urls.length) return
  const { error } = await db.from('whatsapp_media_cache').delete().eq('account_id', accountId).in('photo_url', urls)
  if (error) throw error
}
