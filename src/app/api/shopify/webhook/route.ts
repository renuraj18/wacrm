// ============================================================
// /api/shopify/webhook — product create / update / delete from Shopify.
//
// Public (no session): authenticated by X-Shopify-Hmac-Sha256, the
// base64 HMAC of the raw body keyed with the connected app's client
// secret. The account is found by X-Shopify-Shop-Domain.
//
// We answer 200 immediately and do the work in `after()` — Shopify
// retries anything slower than ~5s. Create/update re-read the product
// from the Admin API rather than trusting the REST-shaped payload, so
// the webhook and full-sync paths write identical rows. Deliveries can
// repeat or arrive out of order; both paths are idempotent and always
// converge on Shopify's current state.
// ============================================================

import { after, NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadConnectionByShop, refreshProduct, removeProduct } from '@/lib/shopify/sync'
import { verifyShopifyHmac } from '@/lib/shopify/webhooks'
import { decrypt } from '@/lib/whatsapp/encryption'

export const maxDuration = 60

const TOPICS = new Set(['products/create', 'products/update', 'products/delete'])

export async function POST(request: Request) {
  const rawBody = await request.text()
  const shopDomain = request.headers.get('x-shopify-shop-domain')?.toLowerCase() ?? ''
  const topic = request.headers.get('x-shopify-topic') ?? ''
  const hmac = request.headers.get('x-shopify-hmac-sha256')

  if (!shopDomain || !hmac) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const conn = await loadConnectionByShop(admin, shopDomain).catch((err) => {
    console.error('[shopify/webhook] config lookup failed:', err)
    return null
  })
  if (!conn) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let secret: string
  try {
    secret = decrypt(conn.client_secret)
  } catch {
    console.error(`[shopify/webhook] client secret for ${shopDomain} could not be decrypted — check ENCRYPTION_KEY.`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!verifyShopifyHmac(rawBody, hmac, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Signed but not a topic we handle (e.g. a leftover subscription): ack
  // so Shopify stops retrying.
  if (!TOPICS.has(topic)) return NextResponse.json({ ok: true })

  let productId: number
  try {
    productId = Number((JSON.parse(rawBody) as { id?: unknown }).id)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return NextResponse.json({ error: 'Missing product id' }, { status: 400 })
  }

  after(async () => {
    try {
      if (topic === 'products/delete') {
        await removeProduct(admin, conn, productId)
      } else {
        await refreshProduct(admin, conn, productId)
      }
    } catch (err) {
      console.error(`[shopify/webhook] ${topic} ${productId} failed:`, err)
    }
  })

  return NextResponse.json({ ok: true })
}
