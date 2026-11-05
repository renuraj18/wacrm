import { createHmac, timingSafeEqual } from 'node:crypto'
import type { GraphqlRunner } from './client'
import { ShopifyError } from './client'
import { ORDER_WEBHOOK_TOPICS } from './order-events'

// ============================================================
// Shopify product webhooks: signature check + idempotent
// registration against the connected store.
// ============================================================

export const PRODUCT_WEBHOOK_TOPICS = [
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
] as const

/**
 * Verify `X-Shopify-Hmac-Sha256`: base64 HMAC-SHA256 of the raw request
 * body, keyed with the app's client secret. Constant-time compare.
 */
export function verifyShopifyHmac(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header || !secret) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(header, 'base64')
  } catch {
    return false
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/**
 * Shopify only delivers to public https endpoints. Returns why `url`
 * can't receive webhooks (e.g. connecting from a local dev server), or
 * null when it can.
 */
export function webhookUrlProblem(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `Live updates need a valid public URL, got "${url}".`
  }
  const host = parsed.hostname
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)
  if (parsed.protocol !== 'https:' || local) {
    return `Live updates need a public https address, but this CRM is running at ${parsed.origin}. Connect from your deployed CRM (or set NEXT_PUBLIC_SITE_URL) and click Save changes; products still sync with Sync now.`
  }
  return null
}

const LIST_QUERY = `
  query ExistingWebhooks {
    webhookSubscriptions(first: 100) {
      edges { node { id topic uri } }
    }
  }
`

const CREATE_MUTATION = `
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $uri: String!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`

const DELETE_MUTATION = `
  mutation DeleteWebhook($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`

interface ExistingWebhook {
  id: string
  topic: string
  uri: string
}

async function listWebhooks(gql: GraphqlRunner): Promise<ExistingWebhook[]> {
  const data = await gql<{ webhookSubscriptions: { edges: { node: ExistingWebhook }[] } }>(
    LIST_QUERY,
  )
  return data.webhookSubscriptions.edges.map((e) => e.node)
}

/** Path of our own webhook endpoint; only subscriptions ending in it are ours. */
const OWN_WEBHOOK_PATH = '/api/shopify/webhook'

/**
 * Make sure every topic in `topics` points at `callbackUrl`. A
 * subscription for one of these topics that points at an older deploy of
 * *this* endpoint is removed so Shopify doesn't keep delivering to a dead
 * host. Subscriptions to anything else (another service's relay on the
 * same Shopify app, e.g. a push-notification worker) are left alone.
 */
async function registerTopics(
  gql: GraphqlRunner,
  callbackUrl: string,
  topicList: readonly string[],
): Promise<void> {
  const existing = await listWebhooks(gql)
  const topics = new Set<string>(topicList)

  for (const hook of existing) {
    if (topics.has(hook.topic) && hook.uri !== callbackUrl && hook.uri.endsWith(OWN_WEBHOOK_PATH)) {
      await gql(DELETE_MUTATION, { id: hook.id })
    }
  }

  for (const topic of topicList) {
    if (existing.some((h) => h.topic === topic && h.uri === callbackUrl)) continue
    const data = await gql<{
      webhookSubscriptionCreate: { userErrors: { field: string[] | null; message: string }[] }
    }>(CREATE_MUTATION, { topic, uri: callbackUrl })
    const errors = data.webhookSubscriptionCreate.userErrors
    if (errors.length) {
      throw new ShopifyError(`Could not register ${topic} webhook: ${errors.map((e) => e.message).join('; ')}`)
    }
  }
}

export function registerProductWebhooks(gql: GraphqlRunner, callbackUrl: string): Promise<void> {
  return registerTopics(gql, callbackUrl, PRODUCT_WEBHOOK_TOPICS)
}

/**
 * Order webhooks drive the Shopify order automation triggers. They need
 * the read_orders scope (and protected customer data access for the
 * phone), so a failure here is reported separately from the product
 * webhooks, which keep working without it.
 */
export function registerOrderWebhooks(gql: GraphqlRunner, callbackUrl: string): Promise<void> {
  return registerTopics(gql, callbackUrl, ORDER_WEBHOOK_TOPICS)
}

/** Remove our product and order subscriptions (used on disconnect). Best-effort. */
export async function removeProductWebhooks(gql: GraphqlRunner): Promise<void> {
  const topics = new Set<string>([...PRODUCT_WEBHOOK_TOPICS, ...ORDER_WEBHOOK_TOPICS])
  for (const hook of await listWebhooks(gql)) {
    if (topics.has(hook.topic) && hook.uri.endsWith(OWN_WEBHOOK_PATH)) {
      await gql(DELETE_MUTATION, { id: hook.id })
    }
  }
}
