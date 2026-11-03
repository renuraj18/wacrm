import { createHmac } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { registerProductWebhooks, verifyShopifyHmac } from './webhooks'
import type { GraphqlRunner } from './client'

const secret = 'shpss_test_secret'
const body = '{"id":8135495778383,"title":"Border Less Saree | BL01"}'
const goodHeader = createHmac('sha256', secret).update(body, 'utf8').digest('base64')

describe('verifyShopifyHmac', () => {
  it('accepts the base64 HMAC of the raw body', () => {
    expect(verifyShopifyHmac(body, goodHeader, secret)).toBe(true)
  })

  it('rejects a tampered body, a wrong secret or a missing header', () => {
    expect(verifyShopifyHmac(body + ' ', goodHeader, secret)).toBe(false)
    expect(verifyShopifyHmac(body, goodHeader, 'other-secret')).toBe(false)
    expect(verifyShopifyHmac(body, null, secret)).toBe(false)
    expect(verifyShopifyHmac(body, 'not-base64!!', secret)).toBe(false)
  })
})

describe('registerProductWebhooks', () => {
  const url = 'https://crm.example.com/api/shopify/webhook'

  function fakeGql(existing: { id: string; topic: string; uri: string }[]) {
    const calls: { query: string; vars?: Record<string, unknown> }[] = []
    const gql = vi.fn(async (query: string, vars?: Record<string, unknown>) => {
      calls.push({ query, vars })
      if (query.includes('ExistingWebhooks')) {
        return { webhookSubscriptions: { edges: existing.map((node) => ({ node })) } }
      }
      if (query.includes('CreateWebhook')) {
        return { webhookSubscriptionCreate: { userErrors: [] } }
      }
      return { webhookSubscriptionDelete: { userErrors: [] } }
    }) as unknown as GraphqlRunner
    return { gql, calls }
  }

  it('creates the three product topics when none exist', async () => {
    const { gql, calls } = fakeGql([])
    await registerProductWebhooks(gql, url)
    const created = calls.filter((c) => c.query.includes('CreateWebhook')).map((c) => c.vars?.topic)
    expect(created).toEqual(['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE'])
  })

  it('is idempotent and replaces subscriptions pointing at an old URL', async () => {
    const { gql, calls } = fakeGql([
      { id: 'w1', topic: 'PRODUCTS_CREATE', uri: url },
      { id: 'w2', topic: 'PRODUCTS_UPDATE', uri: 'https://old.example.com/api/shopify/webhook' },
      { id: 'w3', topic: 'ORDERS_CREATE', uri: 'https://elsewhere.example.com' },
    ])
    await registerProductWebhooks(gql, url)
    const deleted = calls.filter((c) => c.query.includes('DeleteWebhook')).map((c) => c.vars?.id)
    const created = calls.filter((c) => c.query.includes('CreateWebhook')).map((c) => c.vars?.topic)
    expect(deleted).toEqual(['w2'])
    expect(created).toEqual(['PRODUCTS_UPDATE', 'PRODUCTS_DELETE'])
  })
})
