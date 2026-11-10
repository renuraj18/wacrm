import type { SupabaseClient } from '@supabase/supabase-js'

import { cleanText, money, normalizeIndianPhone, summariseItems } from './order-notifications'
import { invoicePath } from './manual-orders'
import type { GraphqlRunner } from './client'
import { sendTemplateToPhone } from './template-to-phone'

export const CART_REMINDER_TEMPLATE = 'shanthi_cart_reminder'
export const REMINDER_WINDOW_DAYS = 90
const MAX_DAYS = 60

const abandonedQuery = (withCustomer: boolean) => `
query Abandoned($q: String!) {
  abandonedCheckouts(first: 100, sortKey: CREATED_AT, reverse: true, query: $q) {
    nodes {
      id
      name
      createdAt
      updatedAt
      completedAt
      abandonedCheckoutUrl
      totalPriceSet { shopMoney { amount } }
      customAttributes { key value }
      ${withCustomer ? 'customer { firstName defaultPhoneNumber { phoneNumber } }' : ''}
      shippingAddress { firstName phone }
      billingAddress { firstName phone }
      lineItems(first: 20) { nodes { title variantTitle quantity } }
    }
  }
}`

export interface AbandonedNode {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  abandonedCheckoutUrl: string
  totalPriceSet: { shopMoney: { amount: string } }
  customAttributes: { key: string; value: string }[]
  customer?: { firstName: string | null; defaultPhoneNumber: { phoneNumber: string } | null } | null
  shippingAddress: { firstName: string | null; phone: string | null } | null
  billingAddress: { firstName: string | null; phone: string | null } | null
  lineItems: { nodes: { title: string; variantTitle: string | null; quantity: number }[] }
}

export interface AbandonedRow {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  customerName: string
  phone: string | null
  items: string
  total: string
  recoverUrl: string
  remindedAt: string | null
}

/** Shape one Shopify checkout for the staff list. Pure, so it can be tested. */
export function toRow(c: AbandonedNode, remindedAt: string | null): AbandonedRow {
  const attr = c.customAttributes.find((a) => a.key.toLowerCase() === 'whatsapp')
  const customerPhone = c.customer?.defaultPhoneNumber?.phoneNumber ?? null
  // The chat's WhatsApp number (from the store), then the checkout contact, then the addresses.
  const phone =
    [attr?.value, customerPhone, c.shippingAddress?.phone, c.billingAddress?.phone]
      .map((p) => normalizeIndianPhone(p ?? null))
      .find(Boolean) ?? null
  const firstName =
    cleanText(c.customer?.firstName) ||
    cleanText(c.shippingAddress?.firstName) ||
    cleanText(c.billingAddress?.firstName) ||
    ''
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    customerName: firstName,
    phone,
    items: summariseItems(
      c.lineItems.nodes.map((n) => ({
        name: n.variantTitle ? `${n.title} - ${n.variantTitle}` : n.title,
        quantity: n.quantity,
      })),
    ),
    total: money(c.totalPriceSet.shopMoney.amount),
    recoverUrl: c.abandonedCheckoutUrl,
    remindedAt,
  }
}

/** Shopify refuses customer fields without read_customers; retry without them. */
const CUSTOMER_NOT_ALLOWED = /access|scope|approved|protected customer/i

/** Abandoned checkouts from the last `days`, not completed, with reminder status. */
export async function listAbandoned(
  db: SupabaseClient,
  accountId: string,
  run: GraphqlRunner,
  days = 7,
): Promise<AbandonedRow[]> {
  const d = Math.min(Math.max(Math.floor(Number(days)) || 7, 1), MAX_DAYS)
  const since = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)
  const vars = { q: `created_at:>=${since}` }

  let data: { abandonedCheckouts: { nodes: AbandonedNode[] } }
  try {
    data = await run(abandonedQuery(true), vars)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!CUSTOMER_NOT_ALLOWED.test(msg)) throw err
    data = await run(abandonedQuery(false), vars)
  }

  const open = data.abandonedCheckouts.nodes.filter((c) => !c.completedAt)
  const reminded = await remindedMap(db, accountId, open.map((c) => c.id))
  return open.map((c) => toRow(c, reminded.get(c.id) ?? null))
}

async function remindedMap(db: SupabaseClient, accountId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!ids.length) return map
  const since = new Date(Date.now() - REMINDER_WINDOW_DAYS * 86_400_000).toISOString()
  const { data, error } = await db
    .from('shopify_cart_reminders')
    .select('checkout_id, reminded_at')
    .eq('account_id', accountId)
    .in('checkout_id', ids)
    .gte('reminded_at', since)
  if (error) throw error
  for (const row of (data ?? []) as { checkout_id: string; reminded_at: string }[]) {
    map.set(row.checkout_id, row.reminded_at)
  }
  return map
}

export interface ReminderResult {
  id: string
  ok: boolean
  skipped?: boolean
  error?: string
  remindedAt?: string
}

/**
 * Send cart reminders for the selected checkouts (max 50). Skips ones that
 * were already reminded unless `force`. A reminder is logged only after a
 * successful send.
 */
export async function sendReminders(
  db: SupabaseClient,
  accountId: string,
  run: GraphqlRunner,
  ids: string[],
  force: boolean,
): Promise<ReminderResult[]> {
  const rows = await listAbandoned(db, accountId, run, MAX_DAYS)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const results: ReminderResult[] = []

  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      results.push({ id, ok: false, error: 'Not found (completed or older than 60 days)' })
      continue
    }
    if (!row.phone) {
      results.push({ id, ok: false, error: 'No phone number' })
      continue
    }
    if (row.remindedAt && !force) {
      results.push({ id, ok: false, skipped: true, error: 'Already reminded' })
      continue
    }
    try {
      await sendTemplateToPhone(db, accountId, {
        phone: row.phone,
        template: CART_REMINDER_TEMPLATE,
        language: 'en_US',
        bodyParams: [row.customerName || 'there', row.items || 'your saree', row.total],
        buttonParam: invoicePath(row.recoverUrl),
      })
      const at = new Date().toISOString()
      const { error } = await db
        .from('shopify_cart_reminders')
        .upsert({ account_id: accountId, checkout_id: id, reminded_at: at }, { onConflict: 'account_id,checkout_id' })
      if (error) throw error
      results.push({ id, ok: true, remindedAt: at })
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}
