// ============================================================
// /api/shopify/config — connect the account to a Shopify store.
//
//   GET    — connection status (admin+). Never returns secrets.
//   POST   — save + verify credentials, register product webhooks,
//            and start the first catalogue sync in the background.
//   PATCH  — toggle "use products in AI answers".
//   DELETE — disconnect: remove webhooks, products and the config.
//
// Admin+ throughout (requireRole + the admin-only RLS on
// shopify_config). Writes go through the service-role client because
// the products/knowledge tables are written by the sync path too.
// ============================================================

import { after, NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  graphqlClient,
  normalizeShopDomain,
  requestAccessToken,
  ShopifyError,
  connectionGraphql,
} from '@/lib/shopify/client'
import { clearProductKnowledge } from '@/lib/shopify/knowledge'
import { fetchShopInfo } from '@/lib/shopify/products'
import { loadConnection, syncAllProducts } from '@/lib/shopify/sync'
import {
  registerOrderWebhooks,
  registerProductWebhooks,
  removeProductWebhooks,
  webhookUrlProblem,
} from '@/lib/shopify/webhooks'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

export const maxDuration = 300

const t = getT('Api')

const STATUS_COLUMNS =
  'shop_domain, client_id, storefront_url, currency, ai_products_enabled, webhooks_registered_at, webhook_error, last_synced_at, last_sync_error, product_count, created_at'

/** Public origin Shopify should deliver webhooks to. */
function webhookUrl(request: Request): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '') || new URL(request.url).origin
  return `${base}/api/shopify/webhook`
}

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data, error } = await supabaseAdmin()
      .from('shopify_config')
      .select(STATUS_COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[shopify/config GET] error:', error)
      return NextResponse.json({ error: t('shopify.loadFailed') }, { status: 500 })
    }
    return NextResponse.json({ config: data ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`admin:shopifyConnect:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      shop_domain?: unknown
      client_id?: unknown
      client_secret?: unknown
    } | null
    if (!body) return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 })

    const shopDomain = normalizeShopDomain(typeof body.shop_domain === 'string' ? body.shop_domain : '')
    if (!shopDomain) {
      return NextResponse.json(
        { error: t('shopify.shopDomainInvalid'), field: 'shop_domain' },
        { status: 400 },
      )
    }
    const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
    if (!clientId) {
      return NextResponse.json(
        { error: t('shopify.clientIdRequired'), field: 'client_id' },
        { status: 400 },
      )
    }

    const admin = supabaseAdmin()
    const existing = await loadConnection(admin, accountId)

    // A blank secret on an existing connection means "keep the saved one"
    // (the form shows it masked), as long as the app stays the same.
    let clientSecret = typeof body.client_secret === 'string' ? body.client_secret.trim() : ''
    if (!clientSecret && existing && existing.client_id === clientId) {
      clientSecret = decrypt(existing.client_secret)
    }
    if (!clientSecret) {
      return NextResponse.json(
        { error: t('shopify.clientSecretRequired'), field: 'client_secret' },
        { status: 400 },
      )
    }

    // Prove the credentials work before saving anything.
    let shopName: string
    let token: Awaited<ReturnType<typeof requestAccessToken>>
    let shop: Awaited<ReturnType<typeof fetchShopInfo>>
    try {
      token = await requestAccessToken(shopDomain, clientId, clientSecret)
      shop = await fetchShopInfo(graphqlClient(shopDomain, token.accessToken))
      shopName = shop.name
    } catch (err) {
      if (err instanceof ShopifyError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    // The same store can only be linked to one CRM account — webhooks
    // carry nothing but the shop domain.
    const { data: claimed } = await admin
      .from('shopify_config')
      .select('account_id')
      .ilike('shop_domain', shopDomain)
      .neq('account_id', accountId)
      .maybeSingle()
    if (claimed) {
      return NextResponse.json({ error: t('shopify.shopClaimed') }, { status: 409 })
    }

    const row = {
      account_id: accountId,
      created_by: userId,
      shop_domain: shopDomain,
      client_id: clientId,
      client_secret: encrypt(clientSecret),
      access_token: encrypt(token.accessToken),
      token_expires_at: token.expiresAt.toISOString(),
      storefront_url: shop.primaryDomain?.url ?? null,
      currency: shop.currencyCode,
      last_sync_error: null,
      updated_at: new Date().toISOString(),
    }
    const { error: saveErr } = await admin
      .from('shopify_config')
      .upsert(row, { onConflict: 'account_id' })
    if (saveErr) {
      console.error('[shopify/config POST] save error:', saveErr)
      return NextResponse.json({ error: t('shopify.saveFailed') }, { status: 500 })
    }

    // Webhooks: a failure here still leaves a working (manual-sync)
    // connection, so report it rather than failing the save.
    const callbackUrl = webhookUrl(request)
    let webhookError: string | null = webhookUrlProblem(callbackUrl)
    // Order webhooks need extra scopes (read_orders); without them the
    // product webhooks still work, so this is reported on its own.
    let orderWebhookError: string | null = null
    if (!webhookError) {
      const gql = graphqlClient(shopDomain, token.accessToken)
      try {
        await registerProductWebhooks(gql, callbackUrl)
      } catch (err) {
        webhookError = (err as Error).message
        console.error('[shopify/config POST] webhook registration failed:', err)
      }
      if (!webhookError) {
        try {
          await registerOrderWebhooks(gql, callbackUrl)
        } catch (err) {
          orderWebhookError = `Order notifications are off: ${(err as Error).message} Add the read_orders scope in the Shopify Dev Dashboard, release a new version, then click Save changes.`
          console.warn('[shopify/config POST] order webhook registration failed:', err)
        }
      }
    }
    // Persist the outcome so Settings keeps showing why live updates are off.
    await admin
      .from('shopify_config')
      .update({
        webhooks_registered_at: webhookError ? null : new Date().toISOString(),
        webhook_error: webhookError ?? orderWebhookError,
      })
      .eq('account_id', accountId)

    after(async () => {
      const conn = await loadConnection(admin, accountId)
      if (!conn) return
      try {
        await syncAllProducts(admin, conn)
      } catch (err) {
        console.error('[shopify/config POST] initial sync failed:', err)
      }
    })

    return NextResponse.json({ ok: true, shop_name: shopName, webhook_error: webhookError ?? orderWebhookError })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as { ai_products_enabled?: unknown } | null
    if (typeof body?.ai_products_enabled !== 'boolean') {
      return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 })
    }
    const admin = supabaseAdmin()
    const conn = await loadConnection(admin, accountId)
    if (!conn) return NextResponse.json({ error: t('shopify.notConnected') }, { status: 404 })

    const { error } = await admin
      .from('shopify_config')
      .update({ ai_products_enabled: body.ai_products_enabled, updated_at: new Date().toISOString() })
      .eq('id', conn.id)
    if (error) {
      console.error('[shopify/config PATCH] error:', error)
      return NextResponse.json({ error: t('shopify.saveFailed') }, { status: 500 })
    }

    // Turning AI on needs a resync to build the documents; off just drops them.
    after(async () => {
      try {
        if (body.ai_products_enabled) {
          await syncAllProducts(admin, { ...conn, ai_products_enabled: true })
        } else {
          await clearProductKnowledge(admin, accountId)
        }
      } catch (err) {
        console.error('[shopify/config PATCH] knowledge update failed:', err)
      }
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin')
    const admin = supabaseAdmin()
    const conn = await loadConnection(admin, accountId)
    if (!conn) return NextResponse.json({ ok: true })

    try {
      await removeProductWebhooks(await connectionGraphql(admin, conn))
    } catch (err) {
      // Best-effort: the app may already be uninstalled. Unmatched
      // deliveries are rejected by the webhook route anyway.
      console.warn('[shopify/config DELETE] webhook removal failed:', err)
    }

    await clearProductKnowledge(admin, accountId)
    const { error: prodErr } = await admin.from('products').delete().eq('account_id', accountId)
    const { error: cfgErr } = await admin.from('shopify_config').delete().eq('id', conn.id)
    if (prodErr || cfgErr) {
      console.error('[shopify/config DELETE] error:', prodErr ?? cfgErr)
      return NextResponse.json({ error: t('shopify.disconnectFailed') }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
