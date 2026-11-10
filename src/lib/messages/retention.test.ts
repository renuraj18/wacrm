import { describe, expect, it } from 'vitest'

import { isRetentionChoice } from './retention'

describe('isRetentionChoice', () => {
  it('accepts the offered periods and nothing else', () => {
    expect(isRetentionChoice(3)).toBe(true)
    expect(isRetentionChoice(24)).toBe(true)
    expect(isRetentionChoice(4)).toBe(false)
    expect(isRetentionChoice('3')).toBe(false)
  })
})
