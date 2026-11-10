// ============================================================
// Store catalogue rules (port of the relay's store.js rules). Pure: they
// work on Shopify's GraphQL shapes, and the fetching lives elsewhere.
// ============================================================

/** Most of one variant a customer may buy in a single cart line. */
export const MAX_QTY = 10
/** "Only N left" shows at or below this many units. */
export const LOW_STOCK = 3

export interface VariantStock {
  availableForSale: boolean
  inventoryQuantity: number | null
  inventoryPolicy?: string | null
  inventoryItem?: { tracked: boolean } | null
}

/** How many of this variant a customer may buy right now. */
export function stockOf(v: VariantStock | null | undefined): number {
  if (!v || !v.availableForSale) return 0
  const tracked = v.inventoryItem ? v.inventoryItem.tracked !== false : true
  if (!tracked || v.inventoryPolicy === 'CONTINUE') return MAX_QTY
  return Math.max(0, Math.min(MAX_QTY, Number(v.inventoryQuantity) || 0))
}

export interface ProductSellability {
  status: string
  onlineStoreUrl: string | null
  tracksInventory?: boolean
  totalInventory?: number | null
  variants?: { nodes: VariantStock[] } | null
}

/** Active and sold online. */
export function sellable(p: ProductSellability | null | undefined): boolean {
  return !!p && p.status === 'ACTIVE' && !!p.onlineStoreUrl
}

/** Sellable with at least one variant that can be bought now. Shopify can count stock that isn't sold online. */
export function inStock(p: ProductSellability | null | undefined): boolean {
  if (!p || !sellable(p)) return false
  if (p.tracksInventory && !(Number(p.totalInventory) > 0)) return false
  const variants = p.variants?.nodes
  return !variants || variants.some((v) => stockOf(v) > 0)
}

export interface PricedVariant extends VariantStock {
  price: string
  compareAtPrice: string | null
}

/** "From ₹899 ~₹1,200~ · 🔥 Only 2 left", using the cheapest variant that can be bought. */
export function priceLine(variants: PricedVariant[], fallbackPrice: string): string {
  const available = variants.filter((v) => stockOf(v) > 0)
  const pool = available.length ? available : variants
  if (!pool.length) return `₹${fallbackPrice}`
  const cheapest = pool.reduce((m, v) => (Number(v.price) < Number(m.price) ? v : m), pool[0])
  const compare = Number(cheapest.compareAtPrice) > Number(cheapest.price) ? ` ~₹${cheapest.compareAtPrice}~` : ''
  const left = available.reduce((s, v) => s + stockOf(v), 0)
  const low =
    available.length && left <= LOW_STOCK && available.every((v) => v.inventoryPolicy !== 'CONTINUE')
      ? ` · 🔥 Only ${left} left`
      : ''
  return `${available.length > 1 ? 'From ' : ''}₹${cheapest.price}${compare}${low}`
}

/** A variant's name for the cart and the card. */
export function variantName(productTitle: string, variantTitle: string | null | undefined): string {
  const t = productTitle.replace(/\s+/g, ' ').trim()
  const v = (variantTitle ?? '').replace(/\s+/g, ' ').trim()
  return v && v !== 'Default Title' ? `${t} – ${v}` : t
}
