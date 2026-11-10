// ============================================================
// The store's checkout link: Shopify's cart page with the customer's items
// already in it, tagged with their WhatsApp number (port of relay checkoutUrl).
// ============================================================

export interface CheckoutLine {
  /** Numeric Shopify variant id. */
  variantId: string
  quantity: number
}

export function checkoutUrl(shopUrl: string | null | undefined, lines: CheckoutLine[], phone: string): string {
  const shop = (shopUrl || 'https://shanthiboutique.com').replace(/\/+$/, '')
  const items = lines.map((l) => `${l.variantId}:${l.quantity}`).join(',')
  const qs = new URLSearchParams({
    'attributes[WhatsApp]': `+${phone}`,
    'attributes[Ordered via]': 'WhatsApp store',
    ref: 'whatsapp-store',
  })
  return `${shop}/cart/${items}?${qs.toString()}`
}

/** Variant id from a Meta catalog content id ("shopify_IN_8123_45678" or "45678"). */
export function variantFromRetailerId(id: string | null | undefined): string | null {
  const m = String(id ?? '').match(/(\d+)\D*$/)
  return m ? m[1] : null
}
