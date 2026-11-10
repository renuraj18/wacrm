// ============================================================
// Sends store replies to WhatsApp and records them in the inbox. Text and
// buttons use the existing Meta helpers; the carousel is posted directly
// because the helpers don't build cards. Card photos go by WhatsApp media id
// when we have one (photo cache, migration 069), by link otherwise.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { sendInteractiveButtons, sendMediaMessage, sendTextMessage, MetaApiError } from '@/lib/whatsapp/meta-api'
import { buildCarouselPayload, type CarouselCard } from './carousel'
import { cachedMediaIds, forgetMediaIds, rememberMediaIds } from './storage'
import type { QuickButton, StoreReply } from './handler'

const GRAPH = 'https://graph.facebook.com/v21.0'
const UPLOAD_CONCURRENCY = 4

export interface StoreSendContext {
  db: SupabaseClient
  accountId: string
  conversationId: string
  phone: string
  phoneNumberId: string
  accessToken: string
}

async function postMessage(ctx: StoreSendContext, payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${GRAPH}/${ctx.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.accessToken}` },
    body: JSON.stringify(payload),
  })
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[]
    error?: { message: string; code?: number; error_data?: { details?: string }; error_user_msg?: string }
  }
  if (!res.ok || !json.messages?.[0]?.id) {
    // Meta's details field names the parameter that was rejected; keep it in the message.
    const detail = json.error?.error_data?.details ?? json.error?.error_user_msg ?? ''
    const message = [json.error?.message ?? `Meta returned HTTP ${res.status}`, detail].filter(Boolean).join(' — ')
    console.error('[store] Meta rejected a message:', JSON.stringify(json.error ?? {}), 'payload:', JSON.stringify(payload).slice(0, 1500))
    throw new MetaApiError(message, {
      code: json.error?.code ?? null,
      httpStatus: res.status,
    })
  }
  return json.messages[0].id
}

/** Downloads a photo and uploads it to WhatsApp, returning its media id. */
export async function uploadPhoto(ctx: StoreSendContext, url: string): Promise<string> {
  const img = await fetch(url)
  if (!img.ok) throw new Error(`photo download failed (HTTP ${img.status})`)
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', 'image/jpeg')
  form.append('file', new Blob([await img.arrayBuffer()], { type: 'image/jpeg' }), 'card.jpg')
  const res = await fetch(`${GRAPH}/${ctx.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
    body: form,
  })
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message: string } }
  if (!res.ok || !json.id) throw new Error(json.error?.message ?? `media upload failed (HTTP ${res.status})`)
  return json.id
}

/** Stores the message in the inbox the way automation sends are stored (sender_type 'bot'). */
async function record(
  ctx: StoreSendContext,
  row: {
    contentText: string
    /** Meta's id for the message; null for a card shown inside a carousel (it has no id of its own). */
    waMessageId: string | null
    interactive?: { body: string; buttons: QuickButton[] }
    /** The photo, so the inbox shows it. */
    mediaUrl?: string
  },
): Promise<void> {
  const { error } = await ctx.db.from('messages').insert({
    conversation_id: ctx.conversationId,
    sender_type: 'bot',
    content_type: row.mediaUrl ? 'image' : row.interactive ? 'interactive' : 'text',
    content_text: row.contentText,
    media_url: row.mediaUrl ?? null,
    interactive_payload: row.interactive
      ? { kind: 'buttons', body: row.interactive.body, buttons: row.interactive.buttons }
      : null,
    message_id: row.waMessageId,
    status: 'sent',
  })
  if (error) throw error
  await ctx.db
    .from('conversations')
    .update({
      last_message_text: row.contentText.slice(0, 200),
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', ctx.conversationId)
    .eq('account_id', ctx.accountId)
}

async function sendText(ctx: StoreSendContext, text: string, buttons: QuickButton[] = []): Promise<void> {
  if (buttons.length >= 1 && buttons.length <= 3) {
    const { messageId } = await sendInteractiveButtons({
      phoneNumberId: ctx.phoneNumberId,
      accessToken: ctx.accessToken,
      to: ctx.phone,
      bodyText: text,
      buttons,
    })
    await record(ctx, { contentText: text, waMessageId: messageId, interactive: { body: text, buttons } })
    return
  }
  const { messageId } = await sendTextMessage({
    phoneNumberId: ctx.phoneNumberId,
    accessToken: ctx.accessToken,
    to: ctx.phone,
    text,
  })
  await record(ctx, { contentText: text, waMessageId: messageId })
}

/** Sends one store reply: a text, a photo with its text, or a carousel of cards. */
export async function sendStoreReply(ctx: StoreSendContext, reply: StoreReply): Promise<void> {
  if (reply.kind === 'text') {
    await sendText(ctx, reply.text, reply.buttons ?? [])
    return
  }
  if (reply.kind === 'image') {
    const { messageId } = await sendMediaMessage({
      phoneNumberId: ctx.phoneNumberId,
      accessToken: ctx.accessToken,
      to: ctx.phone,
      kind: 'image',
      link: reply.image,
      caption: reply.text,
    })
    await record(ctx, { contentText: reply.text, waMessageId: messageId, mediaUrl: reply.image })
    if (reply.buttons.length) await sendText(ctx, 'What next?', reply.buttons)
    return
  }
  await sendCarousel(ctx, reply)
}

async function sendCarousel(
  ctx: StoreSendContext,
  reply: Extract<StoreReply, { kind: 'carousel' }>,
): Promise<void> {
  const urls = reply.cards.map((c) => c.image).filter(Boolean)
  const cached = await cachedMediaIds(ctx.db, ctx.accountId, urls)
  const build = (ids: Map<string, string>): Record<string, unknown> => {
    const cards: CarouselCard[] = reply.cards.map((c) => ({
      image: ids.has(c.image) ? { id: ids.get(c.image) as string } : { link: c.image },
      text: c.text,
      buttons: c.buttons,
    }))
    return buildCarouselPayload(ctx.phone, reply.text, cards)
  }

  let ids = cached
  let waId: string
  try {
    waId = await postMessage(ctx, build(ids))
  } catch (err) {
    // A cached id WhatsApp no longer accepts: send with links and forget the ids.
    if (!ids.size || !(err instanceof MetaApiError)) throw err
    await forgetMediaIds(ctx.db, ctx.accountId, [...ids.keys()])
    ids = new Map()
    waId = await postMessage(ctx, build(ids))
  }
  await record(ctx, { contentText: reply.text, waMessageId: waId })
  // Each card shows in the inbox with its photo, as the customer sees it in the carousel.
  for (const c of reply.cards) {
    await record(ctx, { contentText: c.text, waMessageId: null, mediaUrl: c.image })
  }

  // Upload the photos WhatsApp doesn't have yet, so the next customer gets them by id.
  const missing = urls.filter((u) => !ids.has(u))
  // In parallel (a few at a time), so a carousel of ten isn't ten uploads in a row.
  const uploaded: { url: string; mediaId: string }[] = []
  const unique = [...new Set(missing)]
  for (let i = 0; i < unique.length; i += UPLOAD_CONCURRENCY) {
    const batch = unique.slice(i, i + UPLOAD_CONCURRENCY)
    const results = await Promise.all(
      batch.map((url) =>
        uploadPhoto(ctx, url).then(
          (mediaId) => ({ url, mediaId }),
          (err) => {
            console.warn(`[store] photo upload failed for ${url}:`, err)
            return null
          },
        ),
      ),
    )
    for (const r of results) if (r) uploaded.push(r)
  }
  await rememberMediaIds(ctx.db, ctx.accountId, uploaded.map((u) => ({ url: u.url, mediaId: u.mediaId })))
}
