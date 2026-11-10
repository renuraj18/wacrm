// ============================================================
// POST /api/settings/retention/archive — archive messages older than the
// account's retention period now. Admin+.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { archiveNow, getRetention } from '@/lib/messages/retention'

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const db = supabaseAdmin()
    const moved = await archiveNow(db, ctx.accountId)
    return NextResponse.json({ moved, status: await getRetention(db, ctx.accountId) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
