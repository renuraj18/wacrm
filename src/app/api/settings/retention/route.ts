// ============================================================
// /api/settings/retention — how many months of messages stay in the inbox.
//   GET   → current period and the last archive run (admin+)
//   PATCH → { months } to change the period (admin+)
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getRetention, isRetentionChoice, setRetention } from '@/lib/messages/retention'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    return NextResponse.json(await getRetention(supabaseAdmin(), ctx.accountId))
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as { months?: unknown } | null
    if (!isRetentionChoice(body?.months)) {
      return NextResponse.json({ error: 'Choose 1, 3, 6, 12 or 24 months.' }, { status: 400 })
    }
    await setRetention(supabaseAdmin(), ctx.accountId, body.months)
    return NextResponse.json(await getRetention(supabaseAdmin(), ctx.accountId))
  } catch (err) {
    return toErrorResponse(err)
  }
}
