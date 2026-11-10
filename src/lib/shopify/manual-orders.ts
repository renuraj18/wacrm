// ============================================================
// Manual orders taken on WhatsApp or the phone (port of the relay's
// manual-order.js). Staff pick products, the draft order is created in
// Shopify, and the checkout link goes to the customer on WhatsApp.
//
// Pure rules live here so they can be unit-tested. The Shopify calls and
// the WhatsApp send are in manual-order-service.ts.
// ============================================================

import { cleanText, money, normalizeIndianPhone, summariseItems } from './order-notifications'

export const MANUAL_ORDER_CURRENCY = 'INR'
export const CHECKOUT_TEMPLATE = 'shanthi_order_checkout'

export interface ManualOrderItem {
  variantId?: string | null
  title?: string | null
  quantity: number | string
  price?: number | string | null
}

export interface ManualOrderBody {
  customerName?: string | null
  phone?: string | null
  items?: ManualOrderItem[] | null
  note?: string | null
  shipping?: number | string | null
  discount?: number | string | null
  sendWhatsApp?: boolean
}

/** Thrown for bad input; the route maps it to a 400 with the message. */
export class ManualOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManualOrderError'
  }
}

function amount(v: unknown, label: string, allowZero = true): string {
  const n = Number(String(v).replace(/[,₹\s]/g, ''))
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 1_000_000) {
    throw new ManualOrderError(`${label}: enter a valid amount`)
  }
  return n.toFixed(2)
}

/** Validates the form and returns the Shopify DraftOrderInput, the name and the phone. */
export function buildDraftInput(body: ManualOrderBody | null | undefined): {
  input: Record<string, unknown>
  name: string
  phone: string
} {
  if (!body || typeof body !== 'object') throw new ManualOrderError('Missing order details')

  const name = cleanText(body.customerName).slice(0, 60)
  if (!name) throw new ManualOrderError("Enter the customer's name")

  const phone = normalizeIndianPhone(body.phone)
  if (!phone) throw new ManualOrderError('Enter a valid WhatsApp number (10 digits, or with country code)')

  const items = Array.isArray(body.items) ? body.items : []
  if (!items.length) throw new ManualOrderError('Add at least one item')
  if (items.length > 50) throw new ManualOrderError('Too many items (max 50)')

  const lineItems = items.map((it, i) => {
    const quantity = Math.floor(Number(it.quantity))
    if (!(quantity >= 1 && quantity <= 100)) throw new ManualOrderError(`Item ${i + 1}: quantity must be 1–100`)
    if (it.variantId) {
      if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(String(it.variantId))) {
        throw new ManualOrderError(`Item ${i + 1}: invalid product`)
      }
      const line: Record<string, unknown> = { variantId: it.variantId, quantity }
      if (it.price !== undefined && it.price !== null && it.price !== '') {
        line.priceOverride = { amount: amount(it.price, `Item ${i + 1} price`), currencyCode: MANUAL_ORDER_CURRENCY }
      }
      return line
    }
    const title = cleanText(it.title).slice(0, 120)
    if (!title) throw new ManualOrderError(`Item ${i + 1}: enter a name for the custom item`)
    return {
      title,
      quantity,
      originalUnitPriceWithCurrency: {
        amount: amount(it.price, `Item ${i + 1} price`, false),
        currencyCode: MANUAL_ORDER_CURRENCY,
      },
      requiresShipping: true,
      taxable: false, // prices already include GST
    }
  })

  const input: Record<string, unknown> = {
    taxExempt: true, // sale prices already include GST
    lineItems,
    phone: `+${phone}`,
    tags: ['manual-order', 'whatsapp'],
    customAttributes: [
      { key: 'WhatsApp', value: `+${phone}` },
      { key: 'Customer name', value: name },
    ],
  }

  const note = cleanText(body.note).slice(0, 500)
  if (note) input.note = note

  const shipping = body.shipping === undefined || body.shipping === null || body.shipping === '' ? 0 : Number(amount(body.shipping, 'Shipping'))
  if (shipping > 0) {
    input.shippingLine = { title: 'Shipping', priceWithCurrency: { amount: shipping.toFixed(2), currencyCode: MANUAL_ORDER_CURRENCY } }
  }

  const discount = body.discount === undefined || body.discount === null || body.discount === '' ? 0 : Number(amount(body.discount, 'Discount'))
  if (discount > 0) {
    input.appliedDiscount = { title: 'Discount', value: discount, valueType: 'FIXED_AMOUNT' }
  }

  return { input, name, phone }
}

/**
 * The template's "Complete my order" button is "<store URL>/{{1}}", so send the
 * invoice URL's path without the leading slash.
 */
export function invoicePath(invoiceUrl: string): string {
  const u = new URL(invoiceUrl)
  return `${u.pathname.replace(/^\/+/, '')}${u.search}`
}

export { summariseItems, money }
