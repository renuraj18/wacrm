// ============================================================
// /api/push/devices — register the mobile app's push token.
//
//   POST   { expo_push_token, platform: 'ios'|'android', app_version? }
//          — upsert for the signed-in user (called on every app launch).
//   DELETE { expo_push_token } — on sign-out.
//
// Any member. Authenticated by the session (cookie or the mobile app's
// bearer token, see src/lib/supabase/server.ts). Writes go through the
// service role so a token can move between users/accounts on a shared
// phone; the caller's identity comes from getCurrentAccount().
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getT } from '@/lib/i18n/translate'
import { isExpoPushToken } from '@/lib/push/tokens'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const t = getT('Api')

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`push:register:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      expo_push_token?: unknown
      platform?: unknown
      app_version?: unknown
    } | null
    if (!body || !isExpoPushToken(body.expo_push_token)) {
      return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    }
    if (body.platform !== 'ios' && body.platform !== 'android') {
      return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    }
    const appVersion =
      typeof body.app_version === 'string' ? body.app_version.slice(0, 32) : null

    const { error } = await supabaseAdmin()
      .from('push_devices')
      .upsert(
        {
          account_id: accountId,
          user_id: userId,
          expo_push_token: body.expo_push_token,
          platform: body.platform,
          app_version: appVersion,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'expo_push_token' },
      )
    if (error) {
      console.error('[push/devices POST] upsert error:', error)
      return NextResponse.json({ error: t('common.insertFailed') }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { userId } = await getCurrentAccount()
    const body = (await request.json().catch(() => null)) as { expo_push_token?: unknown } | null
    if (!body || !isExpoPushToken(body.expo_push_token)) {
      return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    }
    // Scoped to the caller so one user can't unregister another's phone.
    const { error } = await supabaseAdmin()
      .from('push_devices')
      .delete()
      .eq('expo_push_token', body.expo_push_token)
      .eq('user_id', userId)
    if (error) {
      console.error('[push/devices DELETE] error:', error)
      return NextResponse.json({ error: t('common.unknownError') }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
