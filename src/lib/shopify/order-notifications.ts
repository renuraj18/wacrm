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
  template: 'shanthi_order_placed' | 'shanthi_order_cancelled' | 'shanthi_order_shipped_v2' | 'shanthi_order_shipped'
  /** Digits-only, Meta form. */
  to: string
  bodyParams: string[]
  /** Value for the URL button's {{1}} (shipped messages: the tracking slug). */
  buttonParam?: string
  /** Used instead when `template` isn't approved yet (Meta error codes below). */
  fallback?: { template: OrderNotificationJob['template']; bodyParams: string[] }
  /** Tracking details the /track page needs, stored before the send. */
  tracking?: { number: string; url: string | null; courier: string | null }
}

/** Meta errors meaning "this template can't be used yet" (not approved, paused, wrong params). */
export const TEMPLATE_UNAVAILABLE_CODES = [132000, 132001, 132015, 132016] as const

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

// ------------------------------------------------------------
// Shipped messages (fulfillments/create and fulfillments/update)
// ------------------------------------------------------------

export const FULFILLMENT_TOPICS = ['fulfillments/create', 'fulfillments/update'] as const

export interface FulfillmentPayload {
  order_id?: number | string
  name?: string
  status?: string | null
  tracking_number?: string | null
  tracking_numbers?: (string | null)[] | null
  tracking_url?: string | null
  tracking_urls?: (string | null)[] | null
  tracking_company?: string | null
  destination?: { first_name?: string | null; phone?: string | null } | null
}

/** Digits-only phone + name of the reseller a fulfillment's order belongs to. */
export interface FulfillmentContext {
  reseller: { phone: string; name: string } | null
  /** Courier from the "Courier: …" order tag, used when Shopify has none. */
  orderCourier: string | null
}

/** The Shanthi Orders app's "Courier: …" tag (tags as a string or an array). */
export function courierFromTags(tags: OrderNotificationOrder['tags']): string | null {
  const tag = tagList(tags).find((t) => /^courier:/i.test(t))
  return tag ? tag.slice('courier:'.length).trim() : null
}

export function isStCourier(name: string | null | undefined): boolean {
  return /^\s*st\b/i.test(String(name ?? '')) || /\bst\s*courier/i.test(String(name ?? ''))
}

export function isDtdc(name: string | null | undefined): boolean {
  return /\bdtdc\b/i.test(String(name ?? ''))
}

/** Courier named in the shipped message: Shopify's company or the app's tag, tidied. */
export function courierLabel(name: string | null | undefined): string {
  const n = cleanText(name)
  if (!n || /professional|\btpc\b/i.test(n)) return 'Professional Couriers'
  if (isStCourier(n)) return 'ST Courier'
  if (isDtdc(n)) return 'DTDC'
  return n
}

/** URL-safe form of a tracking number, used as the /track/<slug> button value. */
export function trackingSlug(tracking: string | null | undefined): string {
  return String(tracking ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
}

/**
 * The shipped message for one fulfillment, or null when there is nothing to
 * send yet (cancelled/failed fulfillment, or no tracking number yet).
 * Uses shanthi_order_shipped_v2 (names the courier) and falls back to the
 * original template until v2 is approved.
 */
export function buildFulfillmentNotification(
  f: FulfillmentPayload,
  ctx: FulfillmentContext,
): OrderNotificationJob | null {
  if (f.status && f.status !== 'success') return null
  const tracking = cleanText(f.tracking_number) || cleanText(f.tracking_numbers?.[0] ?? '')
  if (!tracking) return null

  const to = ctx.reseller?.phone ?? normalizeIndianPhone(f.destination?.phone)
  if (!to) return null

  const name = ctx.reseller?.name ?? (cleanText(f.destination?.first_name) || 'Customer')
  const orderName = String(f.name ?? '').replace(/\.\d+$/, '') // "#1001.1" → "#1001"
  const trackingUrl = f.tracking_url || f.tracking_urls?.[0] || null
  const courier = cleanText(f.tracking_company) || ctx.orderCourier || null
  const oldParams = [name, orderName, tracking]

  return {
    dedupeKey: `shipped:${f.order_id}:${tracking}`,
    template: 'shanthi_order_shipped_v2',
    to,
    bodyParams: [name, orderName, courierLabel(courier), tracking],
    buttonParam: trackingSlug(tracking),
    fallback: { template: 'shanthi_order_shipped', bodyParams: oldParams },
    tracking: { number: tracking, url: trackingUrl, courier },
  }
}
