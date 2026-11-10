import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

import { ORDER_NOTIFICATION_TEMPLATE_LANGUAGE, type OrderNotificationJob } from './order-notifications'

export type OrderNotificationResult = 'sent' | 'duplicate'

/**
 * Send one order message through the Meta template path, once per dedupe
 * key. The claim row is written first, so a repeat delivery (or the paired
 * orders/create + orders/paid) finds it and does nothing. A failed send
 * releases the claim before the error is rethrown.
 *
 * Note: the webhook has already answered Shopify by the time this runs, so
 * a failed send is logged, not retried by Shopify. The relay retried
 * Meta 5xx responses; that retry isn't ported yet.
 */
export async function sendOrderNotification(
  db: SupabaseClient,
  accountId: string,
  job: OrderNotificationJob,
): Promise<OrderNotificationResult> {
  const { data: claimed, error: claimErr } = await db
    .from('shopify_order_notification_sends')
    .upsert(
      { account_id: accountId, dedupe_key: job.dedupeKey },
      { onConflict: 'account_id,dedupe_key', ignoreDuplicates: true },
    )
    .select('dedupe_key')
  if (claimErr) throw claimErr
  if (!claimed || claimed.length === 0) return 'duplicate'

  try {
    const userId = await resolveAuditUserId(db, accountId)
    const { conversationId, contactId } = await resolveConversationByPhone(db, accountId, `+${job.to}`)
    await engineSendTemplate({
      accountId,
      userId,
      conversationId,
      contactId,
      templateName: job.template,
      language: ORDER_NOTIFICATION_TEMPLATE_LANGUAGE,
      params: job.bodyParams,
    })
    return 'sent'
  } catch (err) {
    await db
      .from('shopify_order_notification_sends')
      .delete()
      .eq('account_id', accountId)
      .eq('dedupe_key', job.dedupeKey)
    throw err
  }
}
