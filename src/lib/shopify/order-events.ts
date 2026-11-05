import type { AutomationTriggerType } from '@/types'
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'

// ============================================================
// Shopify order webhooks → automation triggers.
//
// Shopify posts the order (REST-shaped JSON) to /api/shopify/webhook;
// this module turns it into the customer's phone, a display name, and
// the `{{ vars.* }}` an automation can drop into a template or message.
//
// Phones: Shopify stores whatever the customer typed. Following the
// rule in phone-utils (issue #586) we only accept numbers that carry
// the international `+`; a national-format number is skipped rather
// than guessed at, because a wrong guess messages a stranger.
// ============================================================

export const ORDER_WEBHOOK_TOPICS = ['ORDERS_CREATE', 'ORDERS_FULFILLED', 'ORDERS_CANCELLED'] as const

/** `X-Shopify-Topic` header → the automation trigger it fires. */
export const ORDER_TOPIC_TRIGGERS: Record<string, AutomationTriggerType> = {
  'orders/create': 'shopify_order_created',
  'orders/fulfilled': 'shopify_order_fulfilled',
  'orders/cancelled': 'shopify_order_cancelled',
}

interface ShopifyAddress {
  phone?: string | null
  name?: string | null
  first_name?: string | null
  last_name?: string | null
}

export interface ShopifyOrderPayload {
  id?: number | string
  name?: string
  order_number?: number
  phone?: string | null
  total_price?: string
  currency?: string
  order_status_url?: string
  cancel_reason?: string | null
  customer?: (ShopifyAddress & { phone?: string | null }) | null
  shipping_address?: ShopifyAddress | null
  billing_address?: ShopifyAddress | null
  fulfillments?: Array<{
    tracking_company?: string | null
    tracking_number?: string | null
    tracking_url?: string | null
  }>
}

export interface OrderEvent {
  /** Digits-only (Meta form), or null when no usable number was on the order. */
  phone: string | null
  name: string | null
  vars: Record<string, string>
}

function fullName(a: ShopifyAddress | null | undefined): string | null {
  if (!a) return null
  const joined = [a.first_name, a.last_name].filter(Boolean).join(' ').trim()
  return (a.name?.trim() || joined) || null
}

export function parseOrderEvent(order: ShopifyOrderPayload): OrderEvent {
  // Most specific first: the number the customer gave for this order.
  const candidates = [
    order.phone,
    order.customer?.phone,
    order.shipping_address?.phone,
    order.billing_address?.phone,
  ]
  let phone: string | null = null
  for (const c of candidates) {
    phone = parseInternationalPhone(c)
    if (phone) break
  }

  const name =
    fullName(order.customer) ?? fullName(order.shipping_address) ?? fullName(order.billing_address)

  const fulfillment = order.fulfillments?.find((f) => f.tracking_number || f.tracking_url)
  const orderName = order.name ?? (order.order_number != null ? `#${order.order_number}` : '')

  return {
    phone,
    name,
    vars: {
      order_name: orderName,
      order_total: order.total_price ?? '',
      order_currency: order.currency ?? '',
      order_status_url: order.order_status_url ?? '',
      customer_name: name ?? '',
      customer_first_name: name?.split(' ')[0] ?? '',
      cancel_reason: order.cancel_reason ?? '',
      tracking_company: fulfillment?.tracking_company ?? '',
      tracking_number: fulfillment?.tracking_number ?? '',
      tracking_url: fulfillment?.tracking_url ?? '',
    },
  }
}
