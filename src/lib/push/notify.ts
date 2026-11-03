import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Mobile push for inbound WhatsApp messages (Expo Push API).
//
// Who is alerted: the assigned agent when the conversation has one,
// otherwise every agent+ in the account (viewers can't reply, so they
// aren't pinged). Best-effort by design — a push failure must never
// affect webhook processing, so `notifyInboundMessage` never throws.
// ============================================================

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_BATCH_SIZE = 100
const PREVIEW_MAX = 120

const REPLYING_ROLES = new Set(['owner', 'admin', 'agent'])

export interface InboundPushInput {
  accountId: string
  conversationId: string
  assignedAgentId: string | null
  contactName: string | null
  contactPhone: string | null
  contentType: string
  contentText: string | null
}

export interface ExpoPushMessage {
  to: string
  title: string
  body: string
  sound: 'default'
  priority: 'high'
  channelId: 'messages'
  data: { conversation_id: string }
}

/** Short, plain notification body for one inbound message. */
export function previewText(contentType: string, contentText: string | null): string {
  const text = (contentText ?? '').replace(/\s+/g, ' ').trim()
  const media: Record<string, string> = {
    image: '📷 Photo',
    video: '🎥 Video',
    audio: '🎤 Voice note',
    document: '📄 Document',
    location: '📍 Location',
  }
  if (media[contentType]) {
    return text ? `${media[contentType]}: ${truncate(text)}` : media[contentType]
  }
  return text ? truncate(text) : 'New message'
}

function truncate(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text
}

/** User ids to alert: the assignee, or every replying member. */
export function pickRecipients(
  members: { user_id: string; account_role: string }[],
  assignedAgentId: string | null,
): string[] {
  if (assignedAgentId && members.some((m) => m.user_id === assignedAgentId)) {
    return [assignedAgentId]
  }
  return members.filter((m) => REPLYING_ROLES.has(m.account_role)).map((m) => m.user_id)
}

export function buildMessages(tokens: string[], input: InboundPushInput): ExpoPushMessage[] {
  const title = input.contactName?.trim() || (input.contactPhone ? `+${input.contactPhone}` : 'WhatsApp')
  const body = previewText(input.contentType, input.contentText)
  return tokens.map((to) => ({
    to,
    title,
    body,
    sound: 'default',
    priority: 'high',
    channelId: 'messages',
    data: { conversation_id: input.conversationId },
  }))
}

interface ExpoTicket {
  status: 'ok' | 'error'
  details?: { error?: string }
}

/**
 * POST in batches of 100. Returns the tokens Expo says are no longer
 * registered (app uninstalled / token rotated) so the caller can prune.
 */
export async function sendExpoPushes(
  messages: ExpoPushMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const dead: string[] = []
  for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
    const batch = messages.slice(i, i + EXPO_BATCH_SIZE)
    const res = await fetchImpl(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batch),
    })
    if (!res.ok) {
      console.error(`[push] Expo push request failed (HTTP ${res.status})`)
      continue
    }
    const json = (await res.json().catch(() => ({}))) as { data?: ExpoTicket[] }
    ;(json.data ?? []).forEach((ticket, idx) => {
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        dead.push(batch[idx].to)
      }
    })
  }
  return dead
}

/** Alert the right members' phones about an inbound message. Never throws. */
export async function notifyInboundMessage(
  db: SupabaseClient,
  input: InboundPushInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const { data: members, error: membersErr } = await db
      .from('profiles')
      .select('user_id, account_role')
      .eq('account_id', input.accountId)
    if (membersErr || !members?.length) return

    const recipients = pickRecipients(members, input.assignedAgentId)
    if (recipients.length === 0) return

    const { data: devices, error: devErr } = await db
      .from('push_devices')
      .select('expo_push_token')
      .eq('account_id', input.accountId)
      .in('user_id', recipients)
    if (devErr || !devices?.length) return

    const tokens = devices.map((d) => d.expo_push_token as string)
    const dead = await sendExpoPushes(buildMessages(tokens, input), fetchImpl)
    if (dead.length) {
      await db.from('push_devices').delete().in('expo_push_token', dead)
    }
  } catch (err) {
    console.error('[push] notifyInboundMessage failed:', err)
  }
}
