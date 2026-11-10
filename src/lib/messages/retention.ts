// ============================================================
// Message retention: how many months of messages stay in the inbox.
// Older messages are archived by archive_account_messages (migration 072).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const RETENTION_CHOICES = [1, 3, 6, 12, 24] as const
export const DEFAULT_RETENTION_MONTHS = 3

export function isRetentionChoice(n: unknown): n is (typeof RETENTION_CHOICES)[number] {
  return typeof n === 'number' && (RETENTION_CHOICES as readonly number[]).includes(n)
}

export interface RetentionStatus {
  months: number
  lastArchivedAt: string | null
  lastArchivedCount: number
}

export async function getRetention(db: SupabaseClient, accountId: string): Promise<RetentionStatus> {
  const { data, error } = await db
    .from('message_retention')
    .select('months, last_archived_at, last_archived_count')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  const row = data as { months: number; last_archived_at: string | null; last_archived_count: number } | null
  return {
    months: row?.months ?? DEFAULT_RETENTION_MONTHS,
    lastArchivedAt: row?.last_archived_at ?? null,
    lastArchivedCount: row?.last_archived_count ?? 0,
  }
}

export async function setRetention(db: SupabaseClient, accountId: string, months: number): Promise<void> {
  const { error } = await db
    .from('message_retention')
    .upsert({ account_id: accountId, months }, { onConflict: 'account_id' })
  if (error) throw error
}

/** Archives this account's messages older than its retention period. Returns how many moved. */
export async function archiveNow(db: SupabaseClient, accountId: string): Promise<number> {
  const status = await getRetention(db, accountId)
  const { data, error } = await db.rpc('archive_account_messages', {
    p_account: accountId,
    p_months: status.months,
  })
  if (error) throw error
  return Number(data ?? 0)
}
