import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the `contact_id` send path (issue #296): sending an approved
// template to a single contact from the Contact detail view. The route must
// find-or-create the contact's conversation server-side, then run the normal
// send + persistence path — no inbound message required to bootstrap a thread.
// ---------------------------------------------------------------------------

// Records of what the route wrote, so we can assert the right rows landed.
const conversationInserts: Array<Record<string, unknown>> = []
const messageInserts: Array<Record<string, unknown>> = []

// Toggles for the per-test scenario.
let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
// The caller's role, as `requireRole` reads it off the profile. Sending
// requires 'agent'; 'viewer' must be refused before anything reaches Meta.
let callerRole: string = 'admin'
// A conversation created during the request becomes retrievable by id —
// the shared send core re-loads the conversation (with its contact) from
// just the id, so the mock must model insert-then-select-by-id.
let createdConversation: Record<string, unknown> | null = null
let conversationCreatedConcurrently: Record<string, unknown> | null = null
let idempotentMessage: Record<string, unknown> | null = null
let mediaInfoResult: {
  data: { contentType: string; size: number } | null
  error: { status?: number; statusCode?: string; message: string } | null
} = { data: { contentType: 'video/mp4', size: 1024 }, error: null }

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  phone: '+15551234567',
}

// Chainable Supabase mock. A fresh builder per `.from()` call tracks whether
// `.insert()` ran so the terminal resolves to the inserted row for creates
// and the canned select row otherwise.
function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false

    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return {
            data: { account_id: 'acct-1', account_role: callerRole },
            error: null,
          }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'contacts':
          return { data: contactRow, error: null }
        case 'conversations':
          // Once created this request, a by-id reload returns it (with
          // its contact); otherwise fall back to the canned existing row.
          return { data: createdConversation ?? existingConversation, error: null }
        case 'messages':
          return { data: idempotentMessage ?? { id: 'msg-1' }, error: null }
        case 'whatsapp_config':
          return {
            data: {
              id: 'cfg-1',
              account_id: 'acct-1',
              phone_number_id: 'PNID-1',
              access_token: 'enc-token',
            },
            error: null,
          }
        case 'message_templates':
          return { data: null, error: null }
        default:
          return { data: null, error: null }
      }
    }

    let duplicateRequest = false
    const insertResult = () => {
      switch (table) {
        case 'conversations':
          if (conversationCreatedConcurrently) {
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key value' },
            }
          }
          return {
            data: {
              id: 'conv-new',
              account_id: 'acct-1',
              contact_id: 'contact-1',
              contact: CONTACT,
            },
            error: null,
          }
        case 'messages':
          return duplicateRequest
            ? {
                data: null,
                error: { code: '23505', message: 'duplicate send request' },
              }
            : { data: { id: 'msg-1' }, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const terminal = () =>
      Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.update = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'messages' && idempotentMessage) {
        idempotentMessage = { ...idempotentMessage, ...payload }
      }
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'conversations') {
        conversationInserts.push(payload)
        if (conversationCreatedConcurrently) {
          existingConversation = conversationCreatedConcurrently
          return b
        }
        createdConversation = {
          id: 'conv-new',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          contact: CONTACT,
        }
      }
      if (table === 'messages') {
        messageInserts.push(payload)
        const requestId = payload.client_request_id
        if (requestId && idempotentMessage?.client_request_id === requestId) {
          duplicateRequest = true
        } else if (requestId) {
          idempotentMessage = { ...payload, id: 'msg-1' }
        }
      }
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
    storage: {
      from: vi.fn(() => ({
        info: vi.fn(async () => mediaInfoResult),
      })),
    },
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['update', 'eq', 'select']) b[m] = vi.fn(chain)
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null })
      return b
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

const { sendTemplateMessage, sendMediaMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid-media' })),
}))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage,
}))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

function postMedia(
  kind: 'video' | 'document',
  mediaUrl: string,
  requestId = 'c41b1ed3-19a4-4e8d-a960-799e227e52d9',
) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'conv-existing',
        message_type: kind,
        media_url: mediaUrl,
        content_text: 'attachment caption',
        filename: kind === 'document' ? 'invoice.pdf' : null,
        client_request_id: requestId,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send — contact_id template path', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = null
    createdConversation = null
    conversationCreatedConcurrently = null
    idempotentMessage = null
    mediaInfoResult = { data: { contentType: 'video/mp4', size: 1024 }, error: null }
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
    sendMediaMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')

    // A conversation was created for this contact.
    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
    })

    // The template was sent to the contact's number.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const args = (sendTemplateMessage.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    // Meta wants the bare E.164 digits — sanitizePhoneForMeta strips the '+'.
    expect(args.to).toBe('15551234567')
    expect(args.templateName).toBe('order_update')

    // The outbound message was persisted under the new conversation.
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-new',
      content_type: 'template',
      template_name: 'order_update',
      sender_type: 'agent',
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-existing' })
  })

  it('reuses the conversation a concurrent request created when the insert hits the unique index', async () => {
    conversationCreatedConcurrently = {
      id: 'conv-raced',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(conversationInserts).toHaveLength(1)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-raced' })
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/whatsapp/send — role enforcement', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }
    createdConversation = null
    idempotentMessage = null
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
    sendMediaMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('refuses a viewer with 403 and never reaches Meta', async () => {
    // A viewer is read-only (`canSendMessages`). The route used to resolve
    // account_id straight off the profile with no role check: RLS blocked
    // the message INSERT, but the send core calls Meta first, so the
    // customer still received a real WhatsApp message that RLS could not
    // un-send. The gate has to come before any outbound call.
    callerRole = 'viewer'

    const res = await postContactTemplate()

    expect(res.status).toBe(403)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('allows an agent through', async () => {
    callerRole = 'agent'

    const res = await postContactTemplate()

    expect(res.status).toBe(200)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/whatsapp/send — video and document media', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
    messageInserts.length = 0
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }
    idempotentMessage = null
    mediaInfoResult = { data: { contentType: 'video/mp4', size: 1024 }, error: null }
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendMediaMessage.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it.each([
    ['video', 'account-acct-1/1770000000000-clip.mp4', 'video/mp4'],
    ['document', 'account-acct-1/1770000000000-invoice.pdf', 'application/pdf'],
  ] as const)('sends and persists %s attachments', async (kind, path, mimeType) => {
    mediaInfoResult = { data: { contentType: mimeType, size: 1024 }, error: null }
    const url = `https://project.supabase.co/storage/v1/object/public/chat-media/${path}`
    const res = await postMedia(kind, url)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({
      success: true,
      message_id: 'msg-1',
      whatsapp_message_id: 'wamid-media',
    })
    expect(sendMediaMessage).toHaveBeenCalledTimes(1)
    expect(sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind, link: url }),
    )
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      content_type: kind,
      media_url: url,
      status: 'sending',
      client_request_id: 'c41b1ed3-19a4-4e8d-a960-799e227e52d9',
    })
    expect(idempotentMessage).toMatchObject({
      content_type: kind,
      media_url: url,
      status: 'sent',
      message_id: 'wamid-media',
    })
  })

  it('returns the saved result when the same request key is retried', async () => {
    const url =
      'https://project.supabase.co/storage/v1/object/public/chat-media/account-acct-1/clip.mp4'

    const first = await postMedia('video', url)
    const retry = await postMedia('video', url)

    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({
      success: true,
      message_id: 'msg-1',
      whatsapp_message_id: 'wamid-media',
    })
    expect(sendMediaMessage).toHaveBeenCalledTimes(1)
  })

  it('does not retry Meta after an ambiguous network failure', async () => {
    const url =
      'https://project.supabase.co/storage/v1/object/public/chat-media/account-acct-1/clip.mp4'
    sendMediaMessage.mockRejectedValueOnce(new TypeError('network timeout'))

    const first = await postMedia('video', url)
    const retry = await postMedia('video', url)

    expect(first.status).toBe(502)
    expect(retry.status).toBe(409)
    expect(idempotentMessage).toMatchObject({ status: 'sending' })
    expect(sendMediaMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid URLs, MIME types, and missing request keys before Meta', async () => {
    const badUrl = await postMedia('video', 'https://attacker.example/file.mp4')
    expect(badUrl.status).toBe(400)

    mediaInfoResult = {
      data: { contentType: 'video/webm', size: 1024 },
      error: null,
    }
    const badMime = await postMedia(
      'video',
      'https://project.supabase.co/storage/v1/object/public/chat-media/account-acct-1/clip.webm',
    )
    expect(badMime.status).toBe(400)

    const missingKey = await postMedia(
      'document',
      'https://project.supabase.co/storage/v1/object/public/chat-media/account-acct-1/invoice.pdf',
      '',
    )
    expect(missingKey.status).toBe(400)
    expect(sendMediaMessage).not.toHaveBeenCalled()
  })
})
