import { describe, expect, it, vi } from 'vitest'
import {
  buildMessages,
  notifyInboundMessage,
  pickRecipients,
  previewText,
  sendExpoPushes,
  type InboundPushInput,
} from './notify'
import { isExpoPushToken } from './tokens'

const input: InboundPushInput = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  assignedAgentId: null,
  contactName: '𝚁𝚎𝚗𝚞𝚛𝚊𝚓',
  contactPhone: '919632982245',
  contentType: 'text',
  contentText: 'hi, is the pink kolam saree available?',
}

describe('previewText', () => {
  it('keeps short text and trims long text', () => {
    expect(previewText('text', '  hello\n there ')).toBe('hello there')
    const long = 'x'.repeat(200)
    expect(previewText('text', long)).toHaveLength(120)
    expect(previewText('text', long).endsWith('…')).toBe(true)
  })

  it('labels media, with the caption when there is one', () => {
    expect(previewText('image', null)).toBe('📷 Photo')
    expect(previewText('image', 'this one')).toBe('📷 Photo: this one')
    expect(previewText('audio', '')).toBe('🎤 Voice note')
    expect(previewText('interactive', '')).toBe('New message')
  })
})

describe('pickRecipients', () => {
  const members = [
    { user_id: 'owner', account_role: 'owner' },
    { user_id: 'agent', account_role: 'agent' },
    { user_id: 'viewer', account_role: 'viewer' },
  ]

  it('alerts only the assignee when assigned', () => {
    expect(pickRecipients(members, 'agent')).toEqual(['agent'])
  })

  it('alerts every member who can reply when unassigned or assignee left', () => {
    expect(pickRecipients(members, null)).toEqual(['owner', 'agent'])
    expect(pickRecipients(members, 'someone-who-left')).toEqual(['owner', 'agent'])
  })
})

describe('buildMessages', () => {
  it('titles with the contact name and carries the conversation id', () => {
    const [m] = buildMessages(['ExponentPushToken[abcdefgh]'], input)
    expect(m).toMatchObject({
      to: 'ExponentPushToken[abcdefgh]',
      title: '𝚁𝚎𝚗𝚞𝚛𝚊𝚓',
      body: 'hi, is the pink kolam saree available?',
      data: { conversation_id: 'conv-1' },
    })
  })

  it('falls back to the phone number', () => {
    const [m] = buildMessages(['t'], { ...input, contactName: '' })
    expect(m.title).toBe('+919632982245')
  })
})

describe('sendExpoPushes', () => {
  it('batches 100 at a time and returns unregistered tokens', async () => {
    const tokens = Array.from({ length: 150 }, (_, i) => `ExponentPushToken[token${i}xx]`)
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)) as { to: string }[]
      return new Response(
        JSON.stringify({
          data: batch.map((m) =>
            m.to === 'ExponentPushToken[token120xx]'
              ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
              : { status: 'ok' },
          ),
        }),
      )
    })
    const dead = await sendExpoPushes(buildMessages(tokens, input), fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toHaveLength(100)
    expect(dead).toEqual(['ExponentPushToken[token120xx]'])
  })
})

describe('notifyInboundMessage', () => {
  it('never throws, even when the database fails', async () => {
    const db = {
      from: () => {
        throw new Error('db down')
      },
    }
    await expect(notifyInboundMessage(db as never, input)).resolves.toBeUndefined()
  })
})

describe('isExpoPushToken', () => {
  it('accepts Expo tokens only', () => {
    expect(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true)
    expect(isExpoPushToken('ExpoPushToken[abc_def-123]')).toBe(true)
    expect(isExpoPushToken('fcm-raw-token')).toBe(false)
    expect(isExpoPushToken(42)).toBe(false)
  })
})
