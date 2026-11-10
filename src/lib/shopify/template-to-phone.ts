import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

/**
 * Send one approved template to a phone number, creating the contact and
 * conversation if needed. Used by the staff tools (manual orders, cart
 * reminders). `phone` is digits-only, Meta form.
 */
export async function sendTemplateToPhone(
  db: SupabaseClient,
  accountId: string,
  args: {
    phone: string
    template: string
    language: string
    bodyParams: string[]
    /** Value for the URL button's {{1}}. */
    buttonParam?: string
  },
): Promise<{ messageId: string }> {
  const userId = await resolveAuditUserId(db, accountId)
  const { conversationId, contactId } = await resolveConversationByPhone(db, accountId, `+${args.phone}`)
  const result = await engineSendTemplate({
    accountId,
    userId,
    conversationId,
    contactId,
    templateName: args.template,
    language: args.language,
    params: args.bodyParams,
    buttonParams: args.buttonParam ? { 0: args.buttonParam } : undefined,
  })
  return { messageId: result.whatsapp_message_id }
}
