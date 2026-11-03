// ============================================================
// /api/products — search the account's synced Shopify catalogue.
//
//   GET ?q=&type=&limit=&offset=
//
// Any member (viewer+). Reads through the RLS client. Used by the
// Products page, the inbox product picker and the deal form.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

const LIST_COLUMNS =
  'id, shopify_product_id, handle, title, product_type, tags, image_url, price_min, price_max, currency, total_inventory, tracks_inventory, online_url, variants, shopify_updated_at'

/** PostgREST `or()` filters are comma/paren-delimited; strip those plus LIKE wildcards. */
function sanitizeSearch(q: string): string {
  return q.replace(/[,()%*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const params = new URL(request.url).searchParams
    const q = sanitizeSearch(params.get('q') ?? '')
    const type = params.get('type')?.trim() ?? ''
    const limit = clampInt(params.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
    const offset = clampInt(params.get('offset'), 0, 0, 100_000)

    let query = supabase
      .from('products')
      .select(LIST_COLUMNS, { count: 'exact' })
      .eq('account_id', accountId)
      .order('shopify_updated_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1)

    if (q) {
      const like = `%${q}%`
      query = query.or(`title.ilike.${like},product_type.ilike.${like},handle.ilike.${like}`)
    }
    if (type) query = query.eq('product_type', type)

    const { data, error, count } = await query
    if (error) {
      console.error('[GET /api/products] error:', error)
      return NextResponse.json({ error: t('shopify.productsLoadFailed') }, { status: 500 })
    }

    // Product types for the filter — only on the first page to keep
    // pagination requests cheap.
    let types: string[] | undefined
    if (offset === 0) {
      const { data: typeRows } = await supabase
        .from('products')
        .select('product_type')
        .eq('account_id', accountId)
        .neq('product_type', '')
      types = [...new Set((typeRows ?? []).map((r) => r.product_type as string))].sort()
    }

    return NextResponse.json({ products: data ?? [], total: count ?? 0, types })
  } catch (err) {
    return toErrorResponse(err)
  }
}
