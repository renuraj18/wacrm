import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { connectionGraphql } from './client'
import { loadConnection } from './sync'
import type { GraphqlRunner } from './client'

/** The Shopify runner for an account, or a 400 response when Shopify isn't connected. */
export async function shopifyRunnerFor(
  accountId: string,
): Promise<{ db: ReturnType<typeof supabaseAdmin>; run: GraphqlRunner } | NextResponse> {
  const db = supabaseAdmin()
  const conn = await loadConnection(db, accountId)
  if (!conn) {
    return NextResponse.json({ error: 'Connect Shopify in Settings first.' }, { status: 400 })
  }
  return { db, run: await connectionGraphql(db, conn) }
}
