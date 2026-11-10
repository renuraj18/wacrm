// ============================================================
// /api/shopify/webhook — product and order events from Shopify.
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
//
// Order events (orders/create, orders/fulfilled, orders/cancelled) fire
// the matching automation trigger for the customer's WhatsApp number.
// Unlike product refreshes they are NOT idempotent — each one can send
// a message — so X-Shopify-Webhook-Id is claimed first and a repeat
// delivery is acknowledged without dispatching.
// ============================================================

import { after, NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { buildOrderNotification, ORDER_NOTIFICATION_TOPICS } from '@/lib/shopify/order-notifications'
import { sendOrderNotification } from '@/lib/shopify/order-notification-sender'
import {
  ORDER_TOPIC_TRIGGERS,
  parseOrderEvent,
  type ShopifyOrderPayload,
} from '@/lib/shopify/order-events'
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

  if (topic in ORDER_TOPIC_TRIGGERS || topic === 'orders/paid') {
    let order: ShopifyOrderPayload
    try {
      order = JSON.parse(rawBody) as ShopifyOrderPayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const webhookId = request.headers.get('x-shopify-webhook-id')
    after(async () => {
      try {
        await handleOrderEvent(admin, conn.account_id, topic, webhookId, order)
      } catch (err) {
        console.error(`[shopify/webhook] ${topic} failed:`, err)
      }
    })
    return NextResponse.json({ ok: true })
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

type AdminClient = ReturnType<typeof supabaseAdmin>

async function handleOrderEvent(
  admin: AdminClient,
  accountId: string,
  topic: string,
  webhookId: string | null,
  order: ShopifyOrderPayload,
): Promise<void> {
  // Claim the delivery. A conflict means Shopify retried one we already
  // handled. A missing header (never sent by Shopify) is processed
  // rather than dropped.
  if (webhookId) {
    const { data: claimed, error: claimErr } = await admin
      .from('shopify_webhook_events')
      .upsert(
        { webhook_id: webhookId, account_id: accountId, topic },
        { onConflict: 'webhook_id', ignoreDuplicates: true },
      )
      .select('webhook_id')
    if (claimErr) throw claimErr
    if (!claimed || claimed.length === 0) return
  }

  // Opt-in: when the account's order notifications are on, wacrm sends the
  // order messages itself (see order-notifications.ts) and the automations
  // for these topics stay quiet, so a customer never gets both.
  const { data: cfg } = await admin
    .from('shopify_config')
    .select('order_notifications_enabled')
    .eq('account_id', accountId)
    .maybeSingle()
  if (cfg?.order_notifications_enabled && (ORDER_NOTIFICATION_TOPICS as readonly string[]).includes(topic)) {
    const job = buildOrderNotification(topic, order)
    if (!job) return
    const result = await sendOrderNotification(admin, accountId, job)
    console.log(`[shopify/webhook] ${topic} ${job.dedupeKey}: ${result}`)
    return
  }

  // Orders paid later (orders/paid) only feed the order messages above.
  if (!(topic in ORDER_TOPIC_TRIGGERS)) return

  const event = parseOrderEvent(order)
  if (!event.phone) {
    console.warn(
      `[shopify/webhook] ${topic} ${event.vars.order_name}: no usable international phone on the order, skipping`,
    )
    return
  }

  const contactId = await findOrCreateOrderContact(admin, accountId, event.phone, event.name)
  if (!contactId) return

  await runAutomationsForTrigger({
    accountId,
    triggerType: ORDER_TOPIC_TRIGGERS[topic],
    contactId,
    context: { vars: event.vars },
  })
}

async function findOrCreateOrderContact(
  admin: AdminClient,
  accountId: string,
  phone: string,
  name: string | null,
): Promise<string | null> {
  const existing = await findExistingContact(admin, accountId, phone)
  if (existing) return existing.id

  // contacts.user_id is a NOT NULL audit column: attribute the new
  // contact to whoever connected the store.
  const { data: cfg } = await admin
    .from('shopify_config')
    .select('created_by')
    .eq('account_id', accountId)
    .maybeSingle()
  const userId = (cfg as { created_by: string | null } | null)?.created_by
  if (!userId) {
    console.warn('[shopify/webhook] cannot create contact: store has no created_by user')
    return null
  }

  const { data, error } = await admin
    .from('contacts')
    .insert({ account_id: accountId, user_id: userId, phone, name })
    .select('id')
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      return (await findExistingContact(admin, accountId, phone))?.id ?? null
    }
    throw error
  }
  return data.id
}
