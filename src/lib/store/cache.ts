// ============================================================
// Short-lived cache for store catalogue lists (collections). Kept in each
// server instance's memory, so repeat messages on a warm instance don't ask
// Shopify again. Stock and prices are never cached.
// ============================================================

export const COLLECTIONS_TTL_MS = 5 * 60 * 1000

const entries = new Map<string, { value: unknown; expires: number }>()

/** Returns the cached value for `key`, or loads it and keeps it for `ttlMs`. */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key)
  if (hit && hit.expires > Date.now()) return hit.value as T
  const value = await load()
  entries.set(key, { value, expires: Date.now() + ttlMs })
  return value
}

/** For tests. */
export function clearStoreCache(): void {
  entries.clear()
}
