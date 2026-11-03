import { createHmac, timingSafeEqual } from 'node:crypto'
import type { GraphqlRunner } from './client'
import { ShopifyError } from './client'

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

/**
 * Make sure every product topic points at `callbackUrl`. Subscriptions
 * for these topics that point elsewhere (an old deploy URL) are removed
 * so Shopify doesn't keep delivering to a dead host.
 */
export async function registerProductWebhooks(
  gql: GraphqlRunner,
  callbackUrl: string,
): Promise<void> {
  const existing = await listWebhooks(gql)
  const topics = new Set<string>(PRODUCT_WEBHOOK_TOPICS)

  for (const hook of existing) {
    if (topics.has(hook.topic) && hook.uri !== callbackUrl) {
      await gql(DELETE_MUTATION, { id: hook.id })
    }
  }

  for (const topic of PRODUCT_WEBHOOK_TOPICS) {
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

/** Remove our product subscriptions (used on disconnect). Best-effort. */
export async function removeProductWebhooks(gql: GraphqlRunner): Promise<void> {
  const topics = new Set<string>(PRODUCT_WEBHOOK_TOPICS)
  for (const hook of await listWebhooks(gql)) {
    if (topics.has(hook.topic)) await gql(DELETE_MUTATION, { id: hook.id })
  }
}
