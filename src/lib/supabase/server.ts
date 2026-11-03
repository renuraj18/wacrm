import { createServerClient } from '@supabase/ssr'
import { createClient as createTokenClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'

/**
 * Extract a Supabase access token from `Authorization: Bearer <jwt>`.
 * The mobile app authenticates this way — it has no browser cookies.
 * Returns null for anything that isn't a plausible JWT so a stray
 * header (e.g. a public-API `wacrm_` key) never shadows the cookie path.
 */
export function bearerAccessToken(authorization: string | null): string | null {
  if (!authorization) return null
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
  if (!match) return null
  const token = match[1]
  return token.split('.').length === 3 ? token : null
}

export async function createClient() {
  // Mobile app: a Supabase session token in the Authorization header.
  // The client runs as that user, so RLS and `auth.getUser()` behave
  // exactly as they do for a cookie session. Nothing is persisted.
  const token = bearerAccessToken((await headers()).get('authorization'))
  if (token) {
    const client = createTokenClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      },
    )
    // With no stored session, `auth.getUser()` would fail with "Auth
    // session missing". Callers (getCurrentAccount, route handlers) call
    // it without an argument, so validate the header token instead —
    // this still round-trips to Supabase Auth, so a revoked or expired
    // token is rejected.
    const getUser = client.auth.getUser.bind(client.auth)
    client.auth.getUser = (jwt?: string) => getUser(jwt ?? token)
    return client
  }

  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}
