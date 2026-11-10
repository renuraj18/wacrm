import { describe, expect, it } from 'vitest'

import { adTagName } from './ad-tag'

describe('adTagName', () => {
  it('names the tag after the ad headline', () => {
    expect(adTagName({ headline: '  Kolam   sarees  ', source_id: '123' })).toBe('ad: Kolam sarees')
  })
  it('falls back to the ad id when there is no headline', () => {
    expect(adTagName({ source_id: '6789' })).toBe('ad: 6789')
  })
  it('is null without a referral or any label', () => {
    expect(adTagName(null)).toBeNull()
    expect(adTagName({ body: 'hello' })).toBeNull()
  })
  it('keeps the tag short enough for the tags table', () => {
    expect(adTagName({ headline: 'x'.repeat(200) })!.length).toBeLessThanOrEqual(40)
  })
})
