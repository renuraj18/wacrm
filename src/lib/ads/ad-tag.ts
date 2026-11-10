// ============================================================
// Click-to-WhatsApp ads: tag the contact with the ad that brought them in.
// Meta sends a `referral` with the first message from an ad. We turn it into
// a tag such as "ad: Kolam sarees" so staff can see which ads bring orders.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'

export interface AdReferral {
  source_id?: string
  source_type?: string
  headline?: string
  body?: string
}

export const AD_TAG_PREFIX = 'ad: '
const MAX_TAG_NAME = 40
const AD_TAG_COLOR = '#6366f1'

/** "ad: Kolam sarees" from the ad's headline, or "ad: <id>" when Meta gave no headline. Null without a referral. */
export function adTagName(ref: AdReferral | null | undefined): string | null {
  if (!ref) return null
  const label = (ref.headline ?? '').replace(/\s+/g, ' ').trim() || (ref.source_id ?? '').trim()
  if (!label) return null
  return `${AD_TAG_PREFIX}${label}`.slice(0, MAX_TAG_NAME)
}

/** Find or create the ad's tag in this account, then attach it to the contact (once). */
export async function tagContactFromAd(
  db: SupabaseClient,
  args: { accountId: string; userId: string; contactId: string; referral: AdReferral },
): Promise<void> {
  const name = adTagName(args.referral)
  if (!name) return

  const { data: existing, error: findErr } = await db
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', name)
    .maybeSingle()
  if (findErr) throw findErr

  let tagId = (existing as { id: string } | null)?.id
  if (!tagId) {
    const { data: created, error: createErr } = await db
      .from('tags')
      .insert({ account_id: args.accountId, user_id: args.userId, name, color: AD_TAG_COLOR })
      .select('id')
      .single()
    if (createErr) throw createErr
    tagId = (created as { id: string }).id
  }

  await addContactTagIfAbsent(db, { accountId: args.accountId, contactId: args.contactId, tagId })
}
