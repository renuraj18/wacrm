// Client-safe product helpers shared by the Products page, the inbox
// product picker, the deal form and the server-side AI knowledge text.

export interface ProductListItem {
  id: string
  shopify_product_id: number
  handle: string
  title: string
  product_type: string
  tags: string[]
  image_url: string | null
  price_min: number
  price_max: number
  currency: string
  total_inventory: number | null
  tracks_inventory: boolean
  online_url: string | null
  shopify_updated_at: string | null
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount}`
  }
}

export function formatPriceRange(
  p: Pick<ProductListItem, 'price_min' | 'price_max' | 'currency'>,
): string {
  const min = formatMoney(Number(p.price_min), p.currency)
  return Number(p.price_max) > Number(p.price_min)
    ? `${min} – ${formatMoney(Number(p.price_max), p.currency)}`
    : min
}

export function isInStock(
  p: Pick<ProductListItem, 'tracks_inventory' | 'total_inventory'>,
): boolean {
  return !p.tracks_inventory || (p.total_inventory ?? 0) > 0
}

/**
 * WhatsApp caption for sending a product to a customer. Stock lines
 * are passed in already translated so this stays locale-free.
 */
export function productCaption(
  p: Pick<ProductListItem, 'title' | 'price_min' | 'price_max' | 'currency' | 'online_url' | 'tracks_inventory' | 'total_inventory'>,
  labels: { inStock: string; outOfStock: string },
): string {
  const lines = [`*${p.title}*`, formatPriceRange(p), isInStock(p) ? labels.inStock : labels.outOfStock]
  if (p.online_url) lines.push(p.online_url)
  return lines.join('\n')
}
