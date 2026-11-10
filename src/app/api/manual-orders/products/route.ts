// ============================================================
// GET /api/manual-orders/products?q=  — live Shopify product search for
// the manual-order page. Agents and above.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { searchProducts } from '@/lib/shopify/manual-order-service'
import { shopifyRunnerFor } from '@/lib/shopify/staff-tools'
import { ShopifyError } from '@/lib/shopify/client'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const runner = await shopifyRunnerFor(ctx.accountId)
    if (runner instanceof NextResponse) return runner
    const q = new URL(request.url).searchParams.get('q') ?? ''
    return NextResponse.json({ products: await searchProducts(runner.run, q) })
  } catch (err) {
    if (err instanceof ShopifyError) return NextResponse.json({ error: err.message }, { status: 502 })
    return toErrorResponse(err)
  }
}
