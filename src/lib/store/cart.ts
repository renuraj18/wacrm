// ============================================================
// WhatsApp store cart rules (port of the relay's cart behaviour). Pure: the
// database read/write and the live Shopify stock lookup are elsewhere.
// ============================================================

export interface CartLine {
  variantId: string
  productTitle: string
  variantTitle: string
  /** Unit price in rupees, as Shopify gives it. */
  price: number
  quantity: number
}

/** Cart lines shown and totalled. Quantity never goes above stock. */
export function addToCart(items: CartLine[], line: Omit<CartLine, 'quantity'>, stock: number): CartLine[] {
  if (stock < 1) return items
  const existing = items.find((i) => i.variantId === line.variantId)
  if (existing) {
    return items.map((i) =>
      i.variantId === line.variantId ? { ...i, quantity: Math.min(i.quantity + 1, stock) } : i,
    )
  }
  return [...items, { ...line, quantity: 1 }]
}

export function removeFromCart(items: CartLine[], variantId: string): CartLine[] {
  return items.filter((i) => i.variantId !== variantId)
}

/** Drops lines that are sold out and caps quantities at current stock (checked again at checkout). */
export function reconcileCart(items: CartLine[], stockByVariant: Map<string, number>): {
  items: CartLine[]
  removed: CartLine[]
  capped: CartLine[]
} {
  const removed: CartLine[] = []
  const capped: CartLine[] = []
  const kept: CartLine[] = []
  for (const line of items) {
    const stock = stockByVariant.get(line.variantId) ?? 0
    if (stock < 1) {
      removed.push(line)
    } else if (line.quantity > stock) {
      const fixed = { ...line, quantity: stock }
      capped.push(fixed)
      kept.push(fixed)
    } else {
      kept.push(line)
    }
  }
  return { items: kept, removed, capped }
}

export function cartTotal(items: CartLine[]): number {
  return items.reduce((sum, i) => sum + i.price * i.quantity, 0)
}

/** "Kolam Saree - Red × 2" lines and the total, for the cart message. */
export function cartText(items: CartLine[]): string {
  if (!items.length) return 'Your cart is empty.'
  const lines = items.map((i) => {
    const name = i.variantTitle ? `${i.productTitle} - ${i.variantTitle}` : i.productTitle
    return `${name} × ${i.quantity}`
  })
  return `${lines.join('\n')}\nTotal: ₹${Math.round(cartTotal(items)).toLocaleString('en-IN')}`
}
