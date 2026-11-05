import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { contentTriggersFor, hasInteractiveReplyAutomation } from './inbound-triggers'

describe('contentTriggersFor', () => {
  it('fires nothing when a flow or waiting automation consumed the message', () => {
    expect(
      contentTriggersFor({ contentConsumed: true, interactiveReplyId: 'collections', interactiveReplyHandled: true }),
    ).toEqual([])
  })

  it('typed text fires new_message_received and keyword_match', () => {
    expect(
      contentTriggersFor({ contentConsumed: false, interactiveReplyId: null, interactiveReplyHandled: false }),
    ).toEqual(['new_message_received', 'keyword_match'])
  })

  it('a tap handled by an interactive_reply automation skips keyword_match', () => {
    // "Collections" row: Menu – Collections answers it, so Keyword – Collections must not.
    expect(
      contentTriggersFor({ contentConsumed: false, interactiveReplyId: 'collections', interactiveReplyHandled: true }),
    ).toEqual(['new_message_received', 'interactive_reply'])
  })

  it('a tap nothing listens for still reaches keyword_match', () => {
    expect(
      contentTriggersFor({ contentConsumed: false, interactiveReplyId: 'orphan', interactiveReplyHandled: false }),
    ).toEqual(['new_message_received', 'keyword_match', 'interactive_reply'])
  })
})

describe('hasInteractiveReplyAutomation', () => {
  function fakeDb(rows: { trigger_config: unknown }[] | null, error: unknown = null) {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error }),
    }
    return { from: vi.fn(() => query) } as unknown as SupabaseClient
  }

  it('matches a listed reply id', async () => {
    const db = fakeDb([{ trigger_config: { reply_ids: ['catalog', 'new_arrivals'] } }, { trigger_config: { reply_ids: ['collections'] } }])
    expect(await hasInteractiveReplyAutomation(db, 'acct', 'collections')).toBe(true)
    expect(await hasInteractiveReplyAutomation(db, 'acct', 'kolam_sarees')).toBe(false)
  })

  it('fails open on a query error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await hasInteractiveReplyAutomation(fakeDb(null, { message: 'boom' }), 'acct', 'collections')).toBe(false)
    spy.mockRestore()
  })
})
