import type { SupabaseClient } from '@supabase/supabase-js'
import type { InteractiveReplyTriggerConfig } from '@/types'

// Which content-level automation triggers an inbound message fires.
//
// A button / list tap arrives with its row title as the message text
// ("Collections", "Order status"). If an interactive_reply automation
// already answers that tap's id, also running keyword_match would let a
// keyword automation matching the title ("collections") answer the same
// tap a second time. So when the tap is handled by id, keyword_match is
// skipped for that message. Taps nothing listens for still reach
// keyword_match, as before.

export type ContentTrigger = 'new_message_received' | 'keyword_match' | 'interactive_reply'

export function contentTriggersFor(input: {
  contentConsumed: boolean
  interactiveReplyId: string | null | undefined
  interactiveReplyHandled: boolean
}): ContentTrigger[] {
  if (input.contentConsumed) return []
  if (!input.interactiveReplyId) return ['new_message_received', 'keyword_match']
  return input.interactiveReplyHandled
    ? ['new_message_received', 'interactive_reply']
    : ['new_message_received', 'keyword_match', 'interactive_reply']
}

/** True when an active interactive_reply automation lists this reply id. */
export async function hasInteractiveReplyAutomation(
  db: SupabaseClient,
  accountId: string,
  replyId: string,
): Promise<boolean> {
  // Any failure falls back to the old behaviour (keyword_match still
  // runs) — a lookup problem must never stop the tap being answered.
  try {
    const { data, error } = await db
      .from('automations')
      .select('trigger_config')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .eq('trigger_type', 'interactive_reply')
    if (error) throw error
    return (data ?? []).some((row) => {
      const ids = (row.trigger_config as InteractiveReplyTriggerConfig | null)?.reply_ids
      return Array.isArray(ids) && ids.includes(replyId)
    })
  } catch (err) {
    console.error('[automations] interactive_reply lookup failed:', err)
    return false
  }
}
