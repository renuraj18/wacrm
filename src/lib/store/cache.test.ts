import { describe, expect, it } from 'vitest'

import { cached } from './cache'

describe('cached', () => {
  it('loads once, then reuses the value until it expires', async () => {
    let loads = 0
    const load = async () => ++loads
    expect(await cached('k1', 60_000, load)).toBe(1)
    expect(await cached('k1', 60_000, load)).toBe(1)
    expect(loads).toBe(1)
  })
  it('loads again after the time is up', async () => {
    let loads = 0
    const load = async () => ++loads
    await cached('k2', 0, load)
    await cached('k2', 0, load)
    expect(loads).toBe(2)
  })
})
