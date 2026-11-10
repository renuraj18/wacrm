import type { SupabaseClient } from '@supabase/supabase-js'

import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

import {
  ORDER_NOTIFICATION_TEMPLATE_LANGUAGE,
  TEMPLATE_UNAVAILABLE_CODES,
  type OrderNotificationJob,
} from './order-notifications'
import { storeTrackingLink } from './tracking-link'

export type OrderNotificationResult = 'sent' | 'duplicate'

/**
 * Send one order message through the Meta template path, once per dedupe
 * key. The claim row is written first, so a repeat delivery (or the paired
 * orders/create + orders/paid) finds it and does nothing. A failed send
 * releases the claim before the error is rethrown.
 *
 * Shipped messages store their tracking link on the relay first, so the
 * button works when the customer taps it. If the approved v2 template is
 * unavailable, the original template is sent instead.
 *
 * Note: the webhook has already answered Shopify by the time this runs, so
 * a failed send is logged, not retried by Shopify.
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
    if (job.tracking) await storeTrackingLink(job.tracking)

    const send = (msg: { template: OrderNotificationJob['template']; bodyParams: string[] }) =>
      engineSendTemplate({
        accountId,
        userId,
        conversationId,
        contactId,
        templateName: msg.template,
        language: ORDER_NOTIFICATION_TEMPLATE_LANGUAGE,
        params: msg.bodyParams,
        buttonParams: job.buttonParam ? { 0: job.buttonParam } : undefined,
      })

    try {
      await send(job)
    } catch (err) {
      if (!job.fallback || !isTemplateUnavailable(err)) throw err
      console.warn(`[shopify] ${job.template} unavailable, sending ${job.fallback.template}`)
      await send(job.fallback)
    }
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

function isTemplateUnavailable(err: unknown): boolean {
  return (
    err instanceof MetaApiError &&
    err.code !== null &&
    (TEMPLATE_UNAVAILABLE_CODES as readonly number[]).includes(err.code)
  )
}
