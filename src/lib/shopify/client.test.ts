import { describe, it, expect, vi } from 'vitest'
import {
  graphqlClient,
  normalizeShopDomain,
  requestAccessToken,
  ShopifyError,
  tokenNeedsRefresh,
} from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('normalizeShopDomain', () => {
  it('accepts a bare handle, a full host and an admin URL', () => {
    expect(normalizeShopDomain('vgpizr-6r')).toBe('vgpizr-6r.myshopify.com')
    expect(normalizeShopDomain(' VGPIZR-6R.myshopify.com ')).toBe('vgpizr-6r.myshopify.com')
    expect(normalizeShopDomain('https://vgpizr-6r.myshopify.com/admin/products')).toBe(
      'vgpizr-6r.myshopify.com',
    )
  })

  it('rejects custom storefront domains and junk', () => {
    expect(normalizeShopDomain('shanthiboutique.com')).toBeNull()
    expect(normalizeShopDomain('')).toBeNull()
    expect(normalizeShopDomain('bad_host!.myshopify.com')).toBeNull()
  })
})

describe('tokenNeedsRefresh', () => {
  const now = Date.parse('2026-11-03T00:00:00Z')

  it('refreshes when there is no cached token', () => {
    expect(tokenNeedsRefresh({ access_token: null, token_expires_at: null }, now)).toBe(true)
  })

  it('keeps a token with plenty of life left', () => {
    expect(
      tokenNeedsRefresh({ access_token: 'x', token_expires_at: '2026-11-03T12:00:00Z' }, now),
    ).toBe(false)
  })

  it('refreshes inside the 10-minute margin', () => {
    expect(
      tokenNeedsRefresh({ access_token: 'x', token_expires_at: '2026-11-03T00:05:00Z' }, now),
    ).toBe(true)
  })
})

describe('requestAccessToken', () => {
  it('posts the client-credentials form and returns the expiry', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'shpat_x', expires_in: 86399 }))
    const before = Date.now()
    const token = await requestAccessToken('s.myshopify.com', 'cid', 'secret', fetchImpl)

    expect(token.accessToken).toBe('shpat_x')
    expect(token.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 86399 * 1000)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://s.myshopify.com/admin/oauth/access_token')
    const form = new URLSearchParams(String(init.body))
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe('cid')
    expect(form.get('client_secret')).toBe('secret')
  })

  it('explains the cross-organization refusal', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":"shop_not_permitted"}', { status: 400 }),
    )
    await expect(requestAccessToken('s.myshopify.com', 'c', 's', fetchImpl)).rejects.toThrow(
      /same Shopify organization/,
    )
  })

  it('explains bad credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_client"}', { status: 401 }))
    await expect(requestAccessToken('s.myshopify.com', 'c', 's', fetchImpl)).rejects.toThrow(
      /Client ID or Client secret/,
    )
  })
})

describe('graphqlClient', () => {
  it('retries HTTP 429 with backoff, then returns data', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: { shop: { name: 'S' } } }))
    const sleep = vi.fn(async () => {})
    const gql = graphqlClient('s.myshopify.com', 'tok', fetchImpl, sleep)

    await expect(gql('{ shop { name } }')).resolves.toEqual({ shop: { name: 'S' } })
    expect(sleep).toHaveBeenCalledOnce()
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('tok')
  })

  it('retries a THROTTLED GraphQL error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }))
    const gql = graphqlClient('s.myshopify.com', 'tok', fetchImpl, async () => {})
    await expect(gql('{ ok }')).resolves.toEqual({ ok: true })
  })

  it('surfaces a missing-scope 403 as a ShopifyError', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }))
    const gql = graphqlClient('s.myshopify.com', 'tok', fetchImpl, async () => {})
    await expect(gql('{ shop { name } }')).rejects.toBeInstanceOf(ShopifyError)
  })
})
