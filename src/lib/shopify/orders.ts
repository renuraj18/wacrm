import { getT } from '@/lib/i18n/translate'
import { ShopifyError, type GraphqlRunner } from './client'

// ============================================================
// Order status lookup for the `shopify_order_status` automation step.
//
// Privacy rule: a customer only ever sees orders placed with THEIR OWN
// WhatsApp number. We resolve the Shopify customer by that phone and
// read orders through the customer (or filter by customer_id when a
// specific, older order number is asked for) — an order number on its
// own is never enough to reveal an order.
//
// Requires the Shopify app scopes read_orders + read_customers and
// protected customer data access to the phone field. Orders older than
// 60 days additionally need read_all_orders.
// ============================================================

const RECENT_ORDERS = 10
const ORDERS_IN_REPLY = 3

const ORDER_FIELDS = `
  name
  createdAt
  cancelledAt
  displayFinancialStatus
  displayFulfillmentStatus
  fulfillments(first: 5) {
    displayStatus
    trackingInfo(first: 2) { company number url }
  }
`

const ORDERS_BY_PHONE = `
  query OrdersByPhone($customerQuery: String!) {
    shop { ianaTimezone }
    customers(first: 1, query: $customerQuery) {
      edges {
        node {
          id
          orders(first: ${RECENT_ORDERS}, sortKey: CREATED_AT, reverse: true) {
            edges { node { ${ORDER_FIELDS} } }
          }
        }
      }
    }
  }
`

const ORDER_FOR_CUSTOMER = `
  query OrderForCustomer($orderQuery: String!) {
    orders(first: 1, query: $orderQuery) {
      edges { node { ${ORDER_FIELDS} } }
    }
  }
`

export interface ShopifyOrderNode {
  name: string
  createdAt: string
  cancelledAt: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string | null
  fulfillments: {
    displayStatus: string | null
    trackingInfo: { company: string | null; number: string | null; url: string | null }[]
  }[]
}

export type OrderLookupResult =
  | { kind: 'orders'; orders: ShopifyOrderNode[]; requested: string | null; timeZone: string | null }
  | { kind: 'order_not_found'; requested: string }
  | { kind: 'no_orders' }

/** Thrown when the Shopify app lacks the order/customer scopes. */
export class OrderLookupAccessError extends ShopifyError {
  constructor(message: string) {
    super(message)
    this.name = 'OrderLookupAccessError'
  }
}

/** WhatsApp ids are digits with country code ("919632982245") → "+919632982245". */
export function toE164(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
}

/**
 * An order number in the customer's message: "#1038", "1038", "order 1038".
 * 3–7 digits standing alone, so phone numbers (10+ digits) never match.
 */
export function extractOrderNumber(text: string | null | undefined): string | null {
  // Drop phone-like runs first ("+91 96329 82245", "96329-82245") so a
  // spaced phone number is not mistaken for order 96329.
  const withoutPhones = (text ?? '').replace(/\+?\d[\d\s-]{8,}\d/g, ' ')
  const match = withoutPhones.match(/(?<![\d])#?\s?(\d{3,7})(?![\d])/)
  return match ? match[1] : null
}

/** Shopify order names are "#1038"; compare on the digits. */
function sameOrder(name: string, number: string): boolean {
  return name.replace(/\D/g, '') === number
}

function isAccessDenied(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /access denied|ACCESS_DENIED|read_orders|read_customers|protected customer data/i.test(msg)
}

export async function lookupOrdersForPhone(
  gql: GraphqlRunner,
  phone: string,
  messageText: string | null | undefined,
): Promise<OrderLookupResult> {
  const requested = extractOrderNumber(messageText)
  try {
    const data = await gql<{
      shop: { ianaTimezone: string | null }
      customers: {
        edges: { node: { id: string; orders: { edges: { node: ShopifyOrderNode }[] } } }[]
      }
    }>(ORDERS_BY_PHONE, { customerQuery: `phone:${phone}` })

    const customer = data.customers.edges[0]?.node
    const timeZone = data.shop.ianaTimezone
    if (!customer) return requested ? { kind: 'order_not_found', requested } : { kind: 'no_orders' }

    const recent = customer.orders.edges.map((e) => e.node)
    if (!requested) {
      return recent.length
        ? { kind: 'orders', orders: recent.slice(0, ORDERS_IN_REPLY), requested: null, timeZone }
        : { kind: 'no_orders' }
    }

    const inRecent = recent.find((o) => sameOrder(o.name, requested))
    if (inRecent) return { kind: 'orders', orders: [inRecent], requested, timeZone }

    // Older than the recent window: search by name, but only within this
    // customer's orders.
    const customerId = customer.id.split('/').pop()
    const older = await gql<{ orders: { edges: { node: ShopifyOrderNode }[] } }>(ORDER_FOR_CUSTOMER, {
      orderQuery: `name:#${requested} customer_id:${customerId}`,
    })
    const match = older.orders.edges.map((e) => e.node).find((o) => sameOrder(o.name, requested))
    return match
      ? { kind: 'orders', orders: [match], requested, timeZone }
      : { kind: 'order_not_found', requested }
  } catch (err) {
    if (isAccessDenied(err)) {
      throw new OrderLookupAccessError(
        'The Shopify app cannot read orders. Add the read_orders and read_customers scopes and protected customer data access (phone) in the Dev Dashboard, then release a new app version.',
      )
    }
    throw err
  }
}

// ------------------------------------------------------------
// Customer-facing reply
// ------------------------------------------------------------

export type OrderStage =
  | 'cancelled'
  | 'delivered'
  | 'out_for_delivery'
  | 'shipped'
  | 'partly_shipped'
  | 'processing'

export function orderStage(o: ShopifyOrderNode): OrderStage {
  if (o.cancelledAt) return 'cancelled'
  const shipments = o.fulfillments.map((f) => (f.displayStatus ?? '').toUpperCase())
  if (shipments.length && shipments.every((s) => s === 'DELIVERED')) return 'delivered'
  if (shipments.includes('OUT_FOR_DELIVERY')) return 'out_for_delivery'
  switch ((o.displayFulfillmentStatus ?? '').toUpperCase()) {
    case 'FULFILLED':
      return 'shipped'
    case 'PARTIALLY_FULFILLED':
      return 'partly_shipped'
    case 'RESTOCKED':
      return 'cancelled'
    default:
      return 'processing'
  }
}

const PAYMENT_KEYS = new Set([
  'PAID',
  'PENDING',
  'AUTHORIZED',
  'PARTIALLY_PAID',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'VOIDED',
  'EXPIRED',
])

function formatDate(iso: string, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timeZone ?? 'UTC' }).format(new Date(iso))
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(iso))
  }
}

/** Unique tracking entries across all shipments of an order. */
function trackingLines(o: ShopifyOrderNode): { company: string | null; number: string | null; url: string | null }[] {
  const seen = new Set<string>()
  const out: { company: string | null; number: string | null; url: string | null }[] = []
  for (const f of o.fulfillments) {
    for (const ti of f.trackingInfo) {
      const key = `${ti.company}|${ti.number}|${ti.url}`
      if (seen.has(key) || (!ti.number && !ti.url)) continue
      seen.add(key)
      out.push(ti)
    }
  }
  return out
}

export function formatOrderReply(result: OrderLookupResult): string {
  const t = getT('ShopifyOrderStatus')
  if (result.kind === 'no_orders') return t('noOrders')
  if (result.kind === 'order_not_found') return t('orderNotFound', { number: `#${result.requested}` })

  const blocks = result.orders.map((o) => {
    const lines = [
      t('orderLine', { name: o.name, date: formatDate(o.createdAt, result.timeZone) }),
      t('statusLine', { status: t(`stage.${orderStage(o)}`) }),
    ]
    const payment = (o.displayFinancialStatus ?? '').toUpperCase()
    if (PAYMENT_KEYS.has(payment) && orderStage(o) !== 'cancelled') {
      lines.push(t('paymentLine', { payment: t(`payment.${payment}`) }))
    }
    for (const tr of trackingLines(o)) {
      const courier = [tr.company, tr.number].filter(Boolean).join(' ')
      if (courier) lines.push(t('courierLine', { courier }))
      if (tr.url) lines.push(t('trackLine', { url: tr.url }))
    }
    return lines.join('\n')
  })

  const header = result.orders.length === 1 ? t('headerOne') : t('headerMany')
  return [header, ...blocks].join('\n\n')
}

export function formatOrderUnavailable(): string {
  return getT('ShopifyOrderStatus')('unavailable')
}
