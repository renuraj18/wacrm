import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

// ============================================================
// Shopify Admin API client for a single connected store.
//
// Auth is the client-credentials grant of a Dev Dashboard app that is
// installed on the merchant's store (admin-created custom apps were
// retired in January 2026). The app's client id + secret are exchanged
// for an Admin API token that lives ~24h; we cache it encrypted on the
// `shopify_config` row and mint a fresh one shortly before expiry.
// ============================================================

/** Admin API version every request is pinned to. */
export const SHOPIFY_API_VERSION = '2026-10'

/** Mint a new token when the cached one has less than this left. */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000

const MAX_THROTTLE_RETRIES = 4

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'ShopifyError'
  }
}

/** The `shopify_config` columns the client needs. */
export interface ShopifyConnection {
  id: string
  account_id: string
  shop_domain: string
  client_id: string
  client_secret: string // encrypted
  access_token: string | null // encrypted
  token_expires_at: string | null
}

/**
 * Normalise what a merchant types ("my-store", "https://my-store.myshopify.com/admin")
 * to the bare `*.myshopify.com` host. Returns null for anything else —
 * the token endpoint only lives on the myshopify domain.
 */
export function normalizeShopDomain(input: string): string | null {
  let host = input.trim().toLowerCase()
  host = host.replace(/^https?:\/\//, '').split('/')[0] ?? ''
  if (!host) return null
  if (!host.includes('.')) host = `${host}.myshopify.com`
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host) ? host : null
}

export interface MintedToken {
  accessToken: string
  expiresAt: Date
}

/** Exchange app credentials for an Admin API token. */
export async function requestAccessToken(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MintedToken> {
  let res: Response
  try {
    res = await fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })
  } catch (err) {
    throw new ShopifyError(`Could not reach ${shopDomain}: ${(err as Error).message}`)
  }

  const text = await res.text()
  if (!res.ok) {
    throw new ShopifyError(describeTokenError(res.status, text), res.status)
  }
  let json: { access_token?: string; expires_in?: number }
  try {
    json = JSON.parse(text)
  } catch {
    throw new ShopifyError('Shopify returned an unreadable token response.', res.status)
  }
  if (!json.access_token) {
    throw new ShopifyError('Shopify did not return an access token.', res.status)
  }
  const ttlSeconds = typeof json.expires_in === 'number' ? json.expires_in : 86399
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  }
}

function describeTokenError(status: number, body: string): string {
  if (body.includes('shop_not_permitted')) {
    return 'Shopify refused the client-credentials grant for this store. The app and the store must belong to the same Shopify organization, and the app must be installed on the store.'
  }
  if (status === 400 || status === 401) {
    return 'Shopify rejected the Client ID or Client secret. Copy both again from the app’s Settings page in the Dev Dashboard.'
  }
  if (status === 404) {
    return 'That store was not found. Use the store’s .myshopify.com address.'
  }
  return `Shopify token request failed (HTTP ${status}).`
}

export function tokenNeedsRefresh(
  conn: Pick<ShopifyConnection, 'access_token' | 'token_expires_at'>,
  now: number = Date.now(),
): boolean {
  if (!conn.access_token || !conn.token_expires_at) return true
  const expires = new Date(conn.token_expires_at).getTime()
  if (Number.isNaN(expires)) return true
  return expires - now < TOKEN_REFRESH_MARGIN_MS
}

/**
 * A usable Admin API token for this connection, minting and persisting
 * a new one when the cached token is missing or close to expiry.
 */
export async function getAccessToken(
  db: SupabaseClient,
  conn: ShopifyConnection,
): Promise<string> {
  if (!tokenNeedsRefresh(conn)) {
    return decrypt(conn.access_token!)
  }
  const minted = await requestAccessToken(
    conn.shop_domain,
    conn.client_id,
    decrypt(conn.client_secret),
  )
  const { error } = await db
    .from('shopify_config')
    .update({
      access_token: encrypt(minted.accessToken),
      token_expires_at: minted.expiresAt.toISOString(),
    })
    .eq('id', conn.id)
  if (error) console.error('[shopify] failed to cache access token:', error)
  conn.access_token = encrypt(minted.accessToken)
  conn.token_expires_at = minted.expiresAt.toISOString()
  return minted.accessToken
}

export type GraphqlRunner = <T>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>

/**
 * Bind a GraphQL runner to one shop + token. Retries Shopify's
 * throttling (HTTP 429 or a THROTTLED error) with backoff.
 */
export function graphqlClient(
  shopDomain: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): GraphqlRunner {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`
  return async function run<T>(query: string, variables: Record<string, unknown> = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query, variables }),
      })
      if (res.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyError(
          'Shopify denied access. Check the app is installed and has the read_products and read_inventory scopes.',
          res.status,
        )
      }
      if (!res.ok) {
        throw new ShopifyError(`Shopify API request failed (HTTP ${res.status}).`, res.status)
      }
      const json = (await res.json()) as {
        data?: T
        errors?: { message: string; extensions?: { code?: string } }[]
      }
      if (json.errors?.length) {
        const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED')
        if (throttled && attempt < MAX_THROTTLE_RETRIES) {
          await sleep(1000 * 2 ** attempt)
          continue
        }
        throw new ShopifyError(`Shopify API error: ${json.errors.map((e) => e.message).join('; ')}`)
      }
      if (!json.data) throw new ShopifyError('Shopify API returned no data.')
      return json.data
    }
  }
}

/** Convenience: a runner for a stored connection (mints a token as needed). */
export async function connectionGraphql(
  db: SupabaseClient,
  conn: ShopifyConnection,
): Promise<GraphqlRunner> {
  const token = await getAccessToken(db, conn)
  return graphqlClient(conn.shop_domain, token)
}
