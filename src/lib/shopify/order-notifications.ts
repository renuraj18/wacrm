// ============================================================
// Shopify order → WhatsApp order messages (port of the Shanthi relay's
// order-webhooks.js, which wacrm is replacing).
//
//   orders/create    → shanthi_order_placed     (COD now; online waits for orders/paid)
//   orders/paid      → shanthi_order_placed     (same key, so one message per order)
//   orders/cancelled → shanthi_order_cancelled  (refunded amount)
//
// Reseller orders (tagged "Reseller") go to the reseller's billing phone
// and name, never to the customer on the shipping address.
//
// Fulfillment messages (shipped + tracking link) are NOT here yet: the
// "Track my parcel" link's domain is fixed in the approved Meta template,
// so they move after that is settled.
// ============================================================

export const ORDER_NOTIFICATION_TOPICS = ['orders/create', 'orders/paid', 'orders/cancelled'] as const

export const ORDER_NOTIFICATION_TEMPLATE_LANGUAGE = 'en_US'

const MAX_ITEMS_TEXT = 700 // keeps the body well under Meta's 1024-character limit

export interface OrderNotificationOrder {
  id?: number | string
  name?: string
  created_at?: string
  financial_status?: string | null
  payment_gateway_names?: string[] | null
  total_price?: string
  tags?: string[] | string | null
  phone?: string | null
  line_items?: { name?: string | null; quantity?: number | null }[] | null
  note_attributes?: { name?: string | null; value?: string | null }[] | null
  customer?: { first_name?: string | null; phone?: string | null } | null
  shipping_address?: { first_name?: string | null; phone?: string | null } | null
  billing_address?: { first_name?: string | null; phone?: string | null } | null
  refunds?: { transactions?: { kind?: string; status?: string; amount?: string }[] }[] | null
}

export interface OrderNotificationJob {
  /** Send-once key; the same key is never sent twice. */
  dedupeKey: string
  template: 'shanthi_order_placed' | 'shanthi_order_cancelled'
  /** Digits-only, Meta form. */
  to: string
  bodyParams: string[]
}

/** Digits-only Indian number, the relay's rule (national 10-digit numbers are accepted). */
export function normalizeIndianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = String(raw).replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = `91${d}`
  if (d.length < 11 || d.length > 15) return null
  return d
}

/** "1499.00" → "1,499" ; "1499.50" → "1,499.50" (en-IN, like the relay). */
export function money(v: string | number | null | undefined): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  if (!Number.isFinite(n)) return String(v ?? '0')
  const hasPaise = Math.round(n * 100) % 100 !== 0
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })
}

/** WhatsApp rejects template values with newlines, tabs or long runs of spaces. */
export function cleanText(s: string | null | undefined): string {
  if (!s) return ''
  return String(s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

export function summariseItems(items: { name?: string | null; quantity?: number | null }[]): string {
  const parts = items.map((n) => `${cleanText(n.name)} × ${n.quantity ?? 0}`)
  const text = parts.join(', ')
  if (text.length <= MAX_ITEMS_TEXT) return text
  const kept: string[] = []
  let len = 0
  for (const p of parts) {
    if (len + p.length + 2 > MAX_ITEMS_TEXT - 20) break
    kept.push(p)
    len += p.length + 2
  }
  return `${kept.join(', ')} + ${parts.length - kept.length} more`
}

function tagList(tags: OrderNotificationOrder['tags']): string[] {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',')
  return list.map((t) => String(t).trim())
}

/** Reseller orders: the reseller's billing phone and name, or null for a normal order. */
export function resellerContact(order: OrderNotificationOrder): { phone: string; name: string } | null {
  if (!tagList(order.tags).some((t) => t.toLowerCase() === 'reseller')) return null
  const phone = [order.billing_address?.phone, order.phone, order.customer?.phone]
    .map(normalizeIndianPhone)
    .find(Boolean)
  if (!phone) return null
  const name =
    cleanText(order.billing_address?.first_name) || cleanText(order.customer?.first_name) || 'Customer'
  return { phone, name }
}

function isCod(order: OrderNotificationOrder): boolean {
  return (order.payment_gateway_names ?? []).some((g) => /cash on delivery|\bcod\b/i.test(String(g)))
}

/** Online-payment order created before the money arrived: say nothing until orders/paid. */
function isUnpaidOnlineOrder(order: OrderNotificationOrder): boolean {
  const fs = String(order.financial_status ?? '').toLowerCase()
  return !isCod(order) && fs !== 'paid' && fs !== 'partially_paid'
}

/** orders/paid within 2 minutes of the order being created: it was paid at checkout (orders/create covers it). */
function paidAtCheckout(order: OrderNotificationOrder, now: number): boolean {
  const created = Date.parse(order.created_at ?? '')
  return Number.isFinite(created) && now - created < 2 * 60 * 1000
}

export function paymentLabel(order: OrderNotificationOrder): string {
  if (isCod(order)) return 'Cash on delivery'
  const fs = String(order.financial_status ?? '').toLowerCase()
  if (fs === 'paid') return 'Paid online'
  if (fs === 'partially_paid') return 'Partially paid'
  return 'Payment pending'
}

function sumRefunds(order: OrderNotificationOrder): number {
  let total = 0
  for (const r of order.refunds ?? []) {
    for (const t of r.transactions ?? []) {
      if (t.kind === 'refund' && t.status === 'success') total += parseFloat(t.amount ?? '') || 0
    }
  }
  return total
}

function pickPhone(order: OrderNotificationOrder): string | null {
  const reseller = resellerContact(order)
  if (reseller) return reseller.phone
  const whatsappAttr = (order.note_attributes ?? []).find(
    (a) => String(a.name ?? '').toLowerCase() === 'whatsapp',
  )
  const candidates = [
    whatsappAttr?.value,
    order.shipping_address?.phone,
    order.billing_address?.phone,
    order.customer?.phone,
    order.phone,
  ]
  for (const c of candidates) {
    const n = normalizeIndianPhone(c)
    if (n) return n
  }
  return null
}

function firstName(order: OrderNotificationOrder): string {
  const reseller = resellerContact(order)
  if (reseller) return reseller.name
  return (
    cleanText(order.customer?.first_name) ||
    cleanText(order.shipping_address?.first_name) ||
    cleanText(order.billing_address?.first_name) ||
    'Customer'
  )
}

/**
 * The message for one Shopify order topic, or null when nothing should be
 * sent (unpaid online order, or no usable number on the order).
 */
export function buildOrderNotification(
  topic: string,
  order: OrderNotificationOrder,
  now: number = Date.now(),
): OrderNotificationJob | null {
  const to = pickPhone(order)
  if (!to) return null

  switch (topic) {
    case 'orders/create':
      if (isUnpaidOnlineOrder(order)) return null
      return placed(order, to)
    case 'orders/paid':
      if (paidAtCheckout(order, now)) return null
      return placed(order, to)
    case 'orders/cancelled': {
      const refunded = sumRefunds(order)
      return {
        dedupeKey: `cancelled:${order.id}`,
        template: 'shanthi_order_cancelled',
        to,
        bodyParams: [firstName(order), order.name ?? '', money(refunded > 0 ? refunded : order.total_price)],
      }
    }
    default:
      return null
  }
}

function placed(order: OrderNotificationOrder, to: string): OrderNotificationJob {
  return {
    dedupeKey: `placed:${order.id}`,
    template: 'shanthi_order_placed',
    to,
    bodyParams: [
      firstName(order),
      order.name ?? '',
      summariseItems(order.line_items ?? []),
      money(order.total_price),
      paymentLabel(order),
    ],
  }
}
