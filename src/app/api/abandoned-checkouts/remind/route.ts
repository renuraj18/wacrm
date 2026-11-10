// ============================================================
// POST /api/abandoned-checkouts/remind  { ids: string[], force?: boolean }
// — send the cart reminder to the selected checkouts (max 50). Agents and above.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendReminders } from '@/lib/shopify/abandoned-checkouts'
import { shopifyRunnerFor } from '@/lib/shopify/staff-tools'
import { ShopifyError } from '@/lib/shopify/client'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as { ids?: unknown; force?: unknown } | null
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []
    if (!ids.length) return NextResponse.json({ error: 'Select at least one checkout' }, { status: 400 })
    if (ids.length > 50) return NextResponse.json({ error: 'Select up to 50 at a time' }, { status: 400 })

    const runner = await shopifyRunnerFor(ctx.accountId)
    if (runner instanceof NextResponse) return runner
    const results = await sendReminders(runner.db, ctx.accountId, runner.run, ids, body?.force === true)
    return NextResponse.json({ results })
  } catch (err) {
    if (err instanceof ShopifyError) return NextResponse.json({ error: err.message }, { status: 502 })
    return toErrorResponse(err)
  }
}
