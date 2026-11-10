// ============================================================
// GET /api/abandoned-checkouts?days=7 — abandoned Shopify checkouts for
// the staff reminder page, with reminder status. Agents and above.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { listAbandoned } from '@/lib/shopify/abandoned-checkouts'
import { shopifyRunnerFor } from '@/lib/shopify/staff-tools'
import { ShopifyError } from '@/lib/shopify/client'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const runner = await shopifyRunnerFor(ctx.accountId)
    if (runner instanceof NextResponse) return runner
    const days = Number(new URL(request.url).searchParams.get('days') ?? 7)
    return NextResponse.json({ checkouts: await listAbandoned(runner.db, ctx.accountId, runner.run, days) })
  } catch (err) {
    if (err instanceof ShopifyError) return NextResponse.json({ error: err.message }, { status: 502 })
    return toErrorResponse(err)
  }
}
