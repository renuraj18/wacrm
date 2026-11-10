// ============================================================
// POST /api/manual-orders — create a Shopify draft order for a customer
// taken on WhatsApp or the phone, and send the checkout link on WhatsApp
// (unless sendWhatsApp is false). Agents and above.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ManualOrderError, type ManualOrderBody } from '@/lib/shopify/manual-orders'
import { createManualOrder } from '@/lib/shopify/manual-order-service'
import { shopifyRunnerFor } from '@/lib/shopify/staff-tools'
import { ShopifyError } from '@/lib/shopify/client'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as ManualOrderBody | null
    const runner = await shopifyRunnerFor(ctx.accountId)
    if (runner instanceof NextResponse) return runner
    const result = await createManualOrder(runner.db, ctx.accountId, runner.run, body ?? {})
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof ManualOrderError) return NextResponse.json({ error: err.message }, { status: 400 })
    if (err instanceof ShopifyError) return NextResponse.json({ error: err.message }, { status: 502 })
    return toErrorResponse(err)
  }
}
