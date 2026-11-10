/**
 * Stores a parcel's tracking details on the relay Worker, so the "Track my
 * parcel" button in shanthi_order_shipped_v2 (which points at the relay's
 * /track/<slug>) can send the customer to the right courier page.
 * Remove this once the relay is retired and the button points at a new host.
 */
export interface TrackingLink {
  number: string
  url: string | null
  courier: string | null
}

export async function storeTrackingLink(link: TrackingLink): Promise<void> {
  const base = process.env.RELAY_TRACKING_URL
  const token = process.env.RELAY_TRACKING_TOKEN
  if (!base || !token) {
    throw new Error('RELAY_TRACKING_URL and RELAY_TRACKING_TOKEN must be set to send shipped messages')
  }
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/tracking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(link),
  })
  if (!res.ok) throw new Error(`Tracking link store failed (HTTP ${res.status})`)
}
