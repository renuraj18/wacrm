import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- next/headers + Supabase mocks ------------------------------------------
let authorization: string | null = null
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'authorization' ? authorization : null) }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

const getUserCalls: (string | undefined)[] = []
const tokenClientOptions: unknown[] = []
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, opts: unknown) => {
    tokenClientOptions.push(opts)
    return {
      kind: 'token',
      auth: {
        getUser: async (jwt?: string) => {
          getUserCalls.push(jwt)
          return { data: { user: jwt ? { id: 'user-1' } : null }, error: null }
        },
      },
    }
  },
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ kind: 'cookie', auth: { getUser: async () => ({ data: { user: null } }) } }),
}))

const { bearerAccessToken, createClient } = await import('./server')

beforeEach(() => {
  authorization = null
  getUserCalls.length = 0
  tokenClientOptions.length = 0
})

describe('bearerAccessToken', () => {
  it('extracts a JWT-shaped bearer token', () => {
    expect(bearerAccessToken('Bearer aaa.bbb.ccc')).toBe('aaa.bbb.ccc')
    expect(bearerAccessToken('bearer   aaa.bbb.ccc ')).toBe('aaa.bbb.ccc')
  })

  it('ignores missing, malformed and non-JWT values', () => {
    expect(bearerAccessToken(null)).toBeNull()
    expect(bearerAccessToken('Basic abc')).toBeNull()
    expect(bearerAccessToken('Bearer wacrm_live_abc123')).toBeNull()
    expect(bearerAccessToken('Bearer a.b')).toBeNull()
  })
})

describe('createClient', () => {
  it('uses the cookie session when there is no bearer token', async () => {
    const client = (await createClient()) as unknown as { kind: string }
    expect(client.kind).toBe('cookie')
  })

  it('uses the bearer token and validates it on getUser()', async () => {
    authorization = 'Bearer aaa.bbb.ccc'
    const client = (await createClient()) as unknown as {
      kind: string
      auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> }
    }
    expect(client.kind).toBe('token')
    expect(tokenClientOptions[0]).toMatchObject({
      global: { headers: { Authorization: 'Bearer aaa.bbb.ccc' } },
      auth: { persistSession: false },
    })
    const { data } = await client.auth.getUser()
    expect(getUserCalls).toEqual(['aaa.bbb.ccc'])
    expect(data.user?.id).toBe('user-1')
  })
})
