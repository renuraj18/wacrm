// ============================================================
// The WhatsApp store's message handler. Takes one incoming message and
// returns the replies to send. Shopify reads, cart storage and the photo
// cache are passed in, so this stays testable without them. Replies are
// plain objects; the sender turns them into WhatsApp messages.
// ============================================================

import { addToCart, cartText, cartTotal, reconcileCart, removeFromCart, type CartLine } from './cart'
import { checkoutUrl, variantFromRetailerId } from './checkout'
import { ids, parseStoreId } from './ids'
import { inStock, MAX_QTY, priceLine, stockOf, variantName } from './catalog-rules'
import type { GraphqlRunner } from '@/lib/shopify/client'
import {
  fetchAllCollections,
  fetchBestSellers,
  fetchByTitleWords,
  fetchCollectionProducts,
  fetchNewArrivals,
  fetchTickedCollections,
  type StoreProduct,
  type TickedCollection,
} from './catalog-fetch'

export interface Button {
  id: string
  title: string
}

export type StoreReply =
  | { kind: 'text'; text: string; buttons?: Button[] }
  | { kind: 'image'; image: string; text: string; buttons: Button[] }
  | { kind: 'carousel'; text: string; cards: { image: string; text: string; buttons: Button[] }[]; next: Button[] }

export interface StoreDeps {
  run: GraphqlRunner
  shopUrl: string
  storeOrder: string[]
  loadCart: (phone: string) => Promise<CartLine[]>
  saveCart: (phone: string, items: CartLine[]) => Promise<void>
}

export interface StoreMessage {
  phone: string
  text?: string
  buttonId?: string | null
  /** Catalogue cart: product items sent from the WhatsApp catalogue. */
  catalogItems?: { retailer_id?: string | null; quantity?: number | null }[]
}

const BTN_SHOP: Button = { id: ids.menu, title: 'Shop more' }
const BTN_CART: Button = { id: ids.cart, title: 'My cart' }
const BTN_CHECKOUT: Button = { id: ids.checkout, title: 'Checkout' }

const SHOP_WORDS = /\b(shop|shopping|buy|purchase|browse|saree|sarees|collection|collections)\b/i
const NEW_WORDS = /\b(new|latest|arrival|arrivals)\b/i
const CART_WORDS = /\b(cart|basket|checkout|check out)\b/i

/** Which store reply a message needs, or null when it isn't a store message. */
export async function routeStore(deps: StoreDeps, msg: StoreMessage): Promise<StoreReply[] | null> {
  if (msg.catalogItems?.length) return catalogCart(deps, msg)
  const action = parseStoreId(msg.buttonId)
  if (action) return dispatch(deps, msg.phone, action)
  const text = msg.text ?? ''
  if (CART_WORDS.test(text)) return dispatch(deps, msg.phone, { kind: 'cart' })
  if (NEW_WORDS.test(text)) return dispatch(deps, msg.phone, { kind: 'newArrivals', after: null })
  const named = await collectionChoices(deps, text)
  if (named.length === 1) return dispatch(deps, msg.phone, { kind: 'collection', collectionId: numericId(named[0].id), after: null })
  if (named.length > 1) return sareesWithWords(deps, text)
  if (SHOP_WORDS.test(text)) return dispatch(deps, msg.phone, { kind: 'menu' })
  return null
}

const STOP_WORDS = new Set(['sarees', 'saree', 'the', 'and', 'with', 'for', 'price', 'show', 'all'])

/**
 * The published collection a message is asking for. Ticking isn't needed.
 * 1. A whole collection name in the message ("kolam", "soft silk"): the
 *    longest such name wins.
 * 2. Otherwise a collection with the most words the message shares with its
 *    name ("luxury" → "Luxury Soft Silk"); ties go to the shorter name.
 */
export async function collectionNamedIn(deps: StoreDeps, text: string): Promise<{ id: string; title: string } | null> {
  const choices = await collectionChoices(deps, text)
  return choices.length === 1 ? choices[0] : null
}

/**
 * The collections a message is asking for. One result is an open-now match;
 * several are a tie to ask the customer about. Empty when nothing matches.
 */
export async function collectionChoices(deps: StoreDeps, text: string): Promise<{ id: string; title: string }[]> {
  const lower = text.toLowerCase()
  const cols = await fetchAllCollections(deps.run)

  let whole: { id: string; title: string } | null = null
  for (const c of cols) {
    const key = c.title.toLowerCase().replace(/\s*sarees?$/, '').trim()
    if (key.length >= 3 && lower.includes(key) && (!whole || key.length > whole.title.toLowerCase().length)) whole = c
  }
  if (whole) return [whole]

  const words = (lower.match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  const scored = cols
    .map((c) => {
      const titleWords = new Set(c.title.toLowerCase().match(/[a-z]+/g) ?? [])
      return { c, score: words.filter((w) => titleWords.has(w)).length }
    })
    .filter((x) => x.score > 0)
  if (!scored.length) return []
  const top = Math.max(...scored.map((x) => x.score))
  const tied = scored.filter((x) => x.score === top)
  if (tied.length === 1) return [tied[0].c]
  // Equally good matches: let the customer choose.
  return tied.map((x) => x.c)
}

/** A word shared by several collections ("soft silk"): every saree with those words in its title. */
async function sareesWithWords(deps: StoreDeps, text: string): Promise<StoreReply[]> {
  const words = (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  const page = await fetchByTitleWords(deps.run, words, null)
  return productCards(deps, `${words.join(' ')} sarees`, page)
}

type Action = NonNullable<ReturnType<typeof parseStoreId>> | { kind: 'menu' }

async function dispatch(deps: StoreDeps, phone: string, action: Action): Promise<StoreReply[]> {
  switch (action.kind) {
    case 'menu':
      return menu(deps)
    case 'collection':
      return collectionCards(deps, action.collectionId, action.after)
    case 'newArrivals':
      return productCards(deps, 'New arrivals', await fetchNewArrivals(deps.run, action.after))
    case 'bestSellers':
      return productCards(deps, 'Best sellers', await fetchBestSellers(deps.run, 'all-products', action.after))
    case 'product':
      return productDetails(deps, action.productId)
    case 'add':
      return addItem(deps, phone, action.variantId)
    case 'remove':
      return removeItem(deps, phone, action.variantId)
    case 'cart':
      return showCart(deps, phone)
    case 'checkout':
      return checkout(deps, phone)
  }
}

async function menu(deps: StoreDeps): Promise<StoreReply[]> {
  const cols = await fetchTickedCollections(deps.run, deps.storeOrder)
  const intro = 'Welcome to the *Shanthi Boutique* shop 🛍️ You can order and pay right here.'
  if (cols.length < 2) {
    return [{
      kind: 'text',
      text: `${intro}\n\nChoose a collection:\n${cols.map((c) => `• ${c.title}`).join('\n') || '(no collections yet)'}`,
      buttons: [{ id: ids.newArrivals(), title: '✨ New arrivals' }, { id: ids.bestSellers(), title: '🔥 Best sellers' }, BTN_CART],
    }]
  }
  const pageSize = Math.ceil(cols.length / Math.ceil(cols.length / 10))
  const page = cols.slice(0, pageSize)
  return [{
    kind: 'carousel',
    text: `${intro}\n\n*Our collections* 🌸`,
    cards: page.map((c) => ({
      image: c.image ?? '',
      text: `*${c.title}*${c.productsCount ? `\n${c.productsCount} designs` : ''}`,
      buttons: [{ id: ids.collection(numericId(c.id)), title: 'View sarees' }],
    })),
    next: [{ id: ids.newArrivals(), title: '✨ New arrivals' }, { id: ids.bestSellers(), title: '🔥 Best sellers' }, BTN_CART],
  }]
}

async function collectionCards(deps: StoreDeps, collectionId: string, after: string | null): Promise<StoreReply[]> {
  // Button ids carry the numeric id; a full Shopify id is accepted too.
  const numeric = numericId(collectionId)
  if (!/^\d+$/.test(numeric)) {
    console.error(`[store] bad collection id: ${collectionId}`)
    return [{ kind: 'text', text: 'That collection is no longer available.', buttons: [BTN_SHOP] }]
  }
  const gid = `gid://shopify/Collection/${numeric}`
  const { title, products, next } = await fetchCollectionProducts(deps.run, gid, after)
  if (!title) return [{ kind: 'text', text: 'That collection is no longer available.', buttons: [BTN_SHOP] }]
  return productCards(deps, title, { products, next }, numeric)
}

function productCards(
  deps: StoreDeps,
  heading: string,
  page: { products: StoreProduct[]; next: string | null },
  collectionId?: string,
): StoreReply[] {
  const sellers = page.products.filter((p) => p.image)
  if (sellers.length < 2) {
    if (!page.products.length) return [{ kind: 'text', text: `*${heading}*\nNo sarees are in stock right now.`, buttons: [BTN_SHOP] }]
    return [{
      kind: 'text',
      text: `*${heading}*\n${page.products.map((p) => `• ${p.title}`).join('\n')}`,
      buttons: [BTN_SHOP, BTN_CART],
    }]
  }
  const cards = sellers.slice(0, 10).map((p) => ({
    image: p.image ?? '',
    text: `*${cleanTitle(p.title)}*\n${priceLine(p.variants.nodes, p.priceRangeV2.minVariantPrice.amount)}`,
    buttons: [{ id: ids.add(variantIdOf(p)), title: 'Add to cart' }, { id: ids.product(numericId(p.id)), title: 'Details' }],
  }))
  // Only collections page with a collection id; new arrivals and best sellers have no "More" yet.
  const next = page.next && collectionId ? [{ id: ids.collection(collectionId, page.next), title: 'More sarees ▶' }] : []
  return [{ kind: 'carousel', text: `*${heading}*`, cards, next: [...next, BTN_CART, BTN_SHOP] }]
}

async function productDetails(deps: StoreDeps, productId: string): Promise<StoreReply[]> {
  const products = await fetchBestSellers(deps.run, 'all-products', null, 100)
  const p = products.products.find((x) => numericId(x.id) === productId)
  if (!p) return [{ kind: 'text', text: 'That saree is no longer available.', buttons: [BTN_SHOP] }]
  return [{
    kind: 'image',
    image: p.image ?? '',
    text: `*${cleanTitle(p.title)}*\n${priceLine(p.variants.nodes, p.priceRangeV2.minVariantPrice.amount)}`,
    buttons: [{ id: ids.add(variantIdOf(p)), title: 'Add to cart' }, BTN_CART, BTN_SHOP],
  }]
}

async function addItem(deps: StoreDeps, phone: string, variantId: string): Promise<StoreReply[]> {
  const v = await variantStock(deps, variantId)
  if (!v) return [{ kind: 'text', text: 'Sorry, that saree has sold out.', buttons: [BTN_SHOP, BTN_CART] }]
  const cart = addToCart(await deps.loadCart(phone), v.line, v.stock)
  await deps.saveCart(phone, cart)
  return showCart(deps, phone, `Added *${v.line.productTitle}* to your cart ✅`)
}

async function removeItem(deps: StoreDeps, phone: string, variantId: string): Promise<StoreReply[]> {
  await deps.saveCart(phone, removeFromCart(await deps.loadCart(phone), variantId))
  return showCart(deps, phone, 'Removed from your cart.')
}

async function showCart(deps: StoreDeps, phone: string, note = ''): Promise<StoreReply[]> {
  const cart = await deps.loadCart(phone)
  const body = cart.length ? `${cartText(cart)}` : 'Your cart is empty.'
  return [{
    kind: 'text',
    text: `${note ? `${note}\n\n` : ''}*My cart* 🛒\n${body}`,
    buttons: cart.length ? [BTN_CHECKOUT, BTN_SHOP] : [BTN_SHOP],
  }]
}

async function checkout(deps: StoreDeps, phone: string): Promise<StoreReply[]> {
  const cart = await deps.loadCart(phone)
  if (!cart.length) return [{ kind: 'text', text: 'Your cart is empty.', buttons: [BTN_SHOP] }]
  const stock = new Map<string, number>()
  for (const line of cart) {
    const v = await variantStock(deps, line.variantId)
    stock.set(line.variantId, v?.stock ?? 0)
  }
  const { items, removed, capped } = reconcileCart(cart, stock)
  await deps.saveCart(phone, items)
  if (!items.length) return [{ kind: 'text', text: 'Sorry, everything in your cart has sold out.', buttons: [BTN_SHOP] }]
  const notes = [
    ...removed.map((l) => `${l.productTitle} has sold out and was removed.`),
    ...capped.map((l) => `Only ${l.quantity} of ${l.productTitle} left; quantity reduced.`),
  ]
  const link = checkoutUrl(deps.shopUrl, items.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), phone)
  return [{
    kind: 'text',
    text: `${notes.length ? `${notes.join('\n')}\n\n` : ''}*Your order – ₹${Math.round(cartTotal(items)).toLocaleString('en-IN')}*\nPay and add your address here:\n${link}`,
    buttons: [BTN_SHOP],
  }]
}

async function catalogCart(deps: StoreDeps, msg: StoreMessage): Promise<StoreReply[]> {
  let cart = await deps.loadCart(msg.phone)
  for (const item of msg.catalogItems ?? []) {
    const variantId = variantFromRetailerId(item.retailer_id)
    if (!variantId) continue
    const v = await variantStock(deps, variantId)
    if (!v) continue
    const quantity = Math.max(1, Math.min(MAX_QTY, Math.floor(Number(item.quantity) || 1)))
    for (let i = 0; i < quantity; i++) cart = addToCart(cart, v.line, v.stock)
  }
  await deps.saveCart(msg.phone, cart)
  return showCart(deps, msg.phone, 'Your WhatsApp catalogue cart is now your store cart ✅')
}

interface VariantLookup {
  line: Omit<CartLine, 'quantity'>
  stock: number
}

const VARIANT_STOCK = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant {
  id title price availableForSale inventoryQuantity inventoryPolicy inventoryItem { tracked }
  product { title status onlineStoreUrl } } } }`

/** A variant's live stock and cart line, from Shopify. Null when it can't be sold right now. */
export async function variantStock(deps: StoreDeps, variantId: string): Promise<VariantLookup | null> {
  const data = await deps.run<{
    nodes: ({
      id: string
      title: string
      price: string
      availableForSale: boolean
      inventoryQuantity: number | null
      inventoryPolicy: string | null
      inventoryItem: { tracked: boolean } | null
      product: { title: string; status: string; onlineStoreUrl: string | null }
    } | null)[]
  }>(VARIANT_STOCK, { ids: [`gid://shopify/ProductVariant/${variantId}`] })
  const v = data.nodes[0]
  if (!v || v.product.status !== 'ACTIVE' || !v.product.onlineStoreUrl) return null
  const stock = stockOf(v)
  if (stock < 1 || !inStock({ status: v.product.status, onlineStoreUrl: v.product.onlineStoreUrl, variants: { nodes: [v] } })) return null
  return {
    stock,
    line: {
      variantId,
      productTitle: cleanTitle(v.product.title),
      variantTitle: v.title === 'Default Title' ? '' : v.title,
      price: Number(v.price),
    },
  }
}

function numericId(gid: string): string {
  return String(gid).split('/').pop() ?? ''
}

function variantIdOf(p: StoreProduct): string {
  const v = p.variants.nodes[0]
  return v ? numericId(v.id) : ''
}

function cleanTitle(t: string): string {
  return variantName(t, null)
}
