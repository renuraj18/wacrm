import { describe, expect, it } from 'vitest'

import { courierTrackingUrl, isDtdc, isStCourier, stTrackingPage, TPC_TRACK_URL, trackingSlug } from './tracking'

describe('courierTrackingUrl', () => {
  it('uses Shopify\'s tracking URL when there is one', () => {
    expect(courierTrackingUrl('DT1', 'https://track.example/DT1', 'DTDC')).toBe('https://track.example/DT1')
  })
  it('sends ST Courier parcels to ST\'s page, DTDC to DTDC\'s page', () => {
    expect(courierTrackingUrl('ST9', null, 'ST Courier')).toBe('https://stcourier.com/track/shipment')
    expect(courierTrackingUrl('DT 1/2', null, 'DTDC')).toBe('https://www.dtdc.com/track-your-shipment/?awb=DT12')
  })
  it('defaults to TPC with the AWB filled in, unless a fallback template is configured', () => {
    expect(courierTrackingUrl('TP77', null, null)).toBe(TPC_TRACK_URL.replace('{tracking}', 'TP77'))
    expect(courierTrackingUrl('X1', null, null, 'https://other.example/t/{tracking}')).toBe('https://other.example/t/X1')
  })
})

describe('courier detection and slugs', () => {
  it('detects ST Courier and DTDC by name', () => {
    expect(isStCourier('st courier')).toBe(true)
    expect(isStCourier('STCourier Express')).toBe(true)
    expect(isStCourier('Stellar')).toBe(false)
    expect(isDtdc('DTDC Express')).toBe(true)
  })
  it('keeps only URL-safe characters', () => {
    expect(trackingSlug('DT 12/3.4')).toBe('DT1234')
  })
})

describe('stTrackingPage', () => {
  it('shows the AWB and a link to ST Courier', () => {
    const html = stTrackingPage('ST123')
    expect(html).toContain('>ST123<')
    expect(html).toContain('https://stcourier.com/track/shipment')
  })
})
