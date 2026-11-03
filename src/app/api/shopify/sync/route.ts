// ============================================================
// /api/shopify/sync — "Sync now" (admin+).
//
// Kicks off a full catalogue sync in the background and returns 202;
// the settings panel polls GET /api/shopify/config for last_synced_at.
// ============================================================

import { after, NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadConnection, syncAllProducts } from '@/lib/shopify/sync'

export const maxDuration = 300

const t = getT('Api')

export async function POST() {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`admin:shopifySync:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const admin = supabaseAdmin()
    const conn = await loadConnection(admin, accountId)
    if (!conn) return NextResponse.json({ error: t('shopify.notConnected') }, { status: 404 })

    after(async () => {
      try {
        await syncAllProducts(admin, conn)
      } catch (err) {
        console.error('[shopify/sync] failed:', err)
      }
    })

    return NextResponse.json({ ok: true }, { status: 202 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
