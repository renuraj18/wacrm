// ============================================================
// GET /track/<slug> — "Track my parcel". Public (no session): the customer
// opens it from WhatsApp. Sends them to the courier page for the parcel,
// or to ST Courier's AWB page. Unknown slugs go to TPC's home page.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { courierTrackingUrl, stTrackingPage, trackingSlug } from '@/lib/shopify/tracking'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params
  const slug = trackingSlug(decodeURIComponent(raw))
  if (!slug) return Response.redirect('https://www.tpcindia.com/', 302)

  const { data, error } = await supabaseAdmin()
    .from('shopify_tracking_links')
    .select('number, url, courier')
    .eq('slug', slug)
    .maybeSingle()
  if (error) console.error('[track] lookup failed:', error)
  if (!data) return Response.redirect('https://www.tpcindia.com/', 302)

  const link = data as { number: string; url: string | null; courier: string | null }
  if (!/^https?:\/\//i.test(link.url ?? '') && link.courier && /^\s*st\b|st\s*courier/i.test(link.courier)) {
    return new Response(stTrackingPage(slug), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  return Response.redirect(courierTrackingUrl(link.number, link.url, link.courier), 302)
}
