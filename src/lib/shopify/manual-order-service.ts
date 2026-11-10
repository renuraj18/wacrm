import type { SupabaseClient } from '@supabase/supabase-js'

import { cleanText, money, summariseItems } from './order-notifications'
import {
  buildDraftInput,
  CHECKOUT_TEMPLATE,
  invoicePath,
  ManualOrderError,
  type ManualOrderBody,
} from './manual-orders'
import type { GraphqlRunner } from './client'
import { sendTemplateToPhone } from './template-to-phone'

const PRODUCT_SEARCH = `
query ProductSearch($q: String!) {
  products(first: 15, query: $q, sortKey: RELEVANCE) {
    nodes {
      id
      title
      status
      featuredMedia { preview { image { url(transform: {maxWidth: 120}) } } }
      variants(first: 30) {
        nodes { id title price sku inventoryQuantity availableForSale }
      }
    }
  }
}`

const CREATE_DRAFT = `
mutation CreateDraft($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
      name
      invoiceUrl
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 50) { nodes { name quantity } }
    }
    userErrors { field message }
  }
}`

interface ProductNode {
  id: string
  title: string
  status: string
  featuredMedia: { preview: { image: { url: string } | null } | null } | null
  variants: {
    nodes: { id: string; title: string; price: string; sku: string | null; inventoryQuantity: number | null; availableForSale: boolean }[]
  }
}

export interface ProductResult {
  id: string
  title: string
  image: string | null
  variants: { id: string; title: string; price: string; sku: string | null; stock: number | null; available: boolean }[]
}

/** Live Shopify product search (variants and stock), active products only. */
export async function searchProducts(run: GraphqlRunner, rawQuery: string): Promise<ProductResult[]> {
  const q = cleanText(rawQuery).slice(0, 80)
  const query = q ? `status:active AND (${q.replace(/[()]/g, ' ')})` : 'status:active'
  const data = await run<{ products: { nodes: ProductNode[] } }>(PRODUCT_SEARCH, { q: query })
  return data.products.nodes.map((p) => ({
    id: p.id,
    title: p.title,
    image: p.featuredMedia?.preview?.image?.url ?? null,
    variants: p.variants.nodes.map((v) => ({
      id: v.id,
      title: v.title === 'Default Title' ? '' : v.title,
      price: v.price,
      sku: v.sku,
      stock: v.inventoryQuantity,
      available: v.availableForSale,
    })),
  }))
}

interface DraftResult {
  draftOrderCreate: {
    draftOrder: {
      id: string
      name: string
      invoiceUrl: string
      totalPriceSet: { shopMoney: { amount: string } }
      lineItems: { nodes: { name: string; quantity: number }[] }
    } | null
    userErrors: { field: string[] | null; message: string }[]
  }
}

/** Shopify says the app isn't allowed the customer's phone number: retry without it. */
const PHONE_NOT_ALLOWED = /approved|access denied|protected customer/i

export interface ManualOrderResult {
  order: {
    id: string
    name: string
    total: string
    items: string
    checkoutUrl: string
    customerName: string
    phone: string
  }
  whatsapp: { sent: boolean; messageId?: string; error?: string }
}

/**
 * Create the Shopify draft order, then (unless turned off) send the
 * checkout template with the payment link. The order is kept even if the
 * WhatsApp send fails, so staff can copy the link.
 */
export async function createManualOrder(
  db: SupabaseClient,
  accountId: string,
  run: GraphqlRunner,
  body: ManualOrderBody,
): Promise<ManualOrderResult> {
  const { input, name, phone } = buildDraftInput(body)

  let data: DraftResult
  try {
    data = await run<DraftResult>(CREATE_DRAFT, { input })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!PHONE_NOT_ALLOWED.test(msg)) throw err
    const { phone: _drop, ...withoutPhone } = input
    data = await run<DraftResult>(CREATE_DRAFT, { input: withoutPhone })
  }

  const result = data.draftOrderCreate
  if (result.userErrors.length) {
    throw new ManualOrderError(result.userErrors.map((e) => e.message).join('; '))
  }
  const draft = result.draftOrder
  if (!draft) throw new ManualOrderError('Shopify did not return the draft order')

  const itemsText = summariseItems(draft.lineItems.nodes)
  const total = money(draft.totalPriceSet.shopMoney.amount)
  const out: ManualOrderResult = {
    order: {
      id: draft.id,
      name: draft.name,
      total,
      items: itemsText,
      checkoutUrl: draft.invoiceUrl,
      customerName: name,
      phone: `+${phone}`,
    },
    whatsapp: { sent: false },
  }

  if (body.sendWhatsApp === false) return out
  try {
    const sent = await sendTemplateToPhone(db, accountId, {
      phone,
      template: CHECKOUT_TEMPLATE,
      language: 'en_US',
      bodyParams: [name, itemsText, total],
      buttonParam: invoicePath(draft.invoiceUrl),
    })
    out.whatsapp = { sent: true, messageId: sent.messageId }
  } catch (err) {
    out.whatsapp = { sent: false, error: err instanceof Error ? err.message : String(err) }
  }
  return out
}
