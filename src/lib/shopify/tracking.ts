// ============================================================
// "Track my parcel" — the courier page for a parcel (port of the relay's
// tracking logic). Used by the /track/<slug> route.
// ============================================================

/** Professional Couriers (TPC): the AWB is filled in from {tracking}. */
export const TPC_TRACK_URL = 'https://www.tpcindia.com/track-info.aspx?id={tracking}&type=0&service=0'
/** ST Courier has no per-parcel link: the AWB is typed on its site. */
export const ST_TRACK_URL = 'https://stcourier.com/track/shipment'
/** DTDC fills in the AWB from ?awb= */
export const DTDC_TRACK_URL = 'https://www.dtdc.com/track-your-shipment/?awb={tracking}'

export function isStCourier(name: string | null | undefined): boolean {
  return /^\s*st\b/i.test(String(name ?? '')) || /\bst\s*courier/i.test(String(name ?? ''))
}

export function isDtdc(name: string | null | undefined): boolean {
  return /\bdtdc\b/i.test(String(name ?? ''))
}

/** Digits, letters, - and _ only, so a slug is safe inside a URL and HTML. */
export function trackingSlug(tracking: string | null | undefined): string {
  return String(tracking ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
}

/**
 * Where the customer goes: Shopify's own tracking URL when there is one,
 * otherwise the courier's page for this AWB.
 */
export function courierTrackingUrl(
  number: string,
  shopifyUrl: string | null | undefined,
  courier: string | null | undefined,
  fallbackTemplate: string = TPC_TRACK_URL,
): string {
  if (/^https?:\/\//i.test(shopifyUrl ?? '')) return shopifyUrl as string
  if (isStCourier(courier)) return ST_TRACK_URL
  const clean = trackingSlug(number)
  if (isDtdc(courier)) return DTDC_TRACK_URL.replace('{tracking}', encodeURIComponent(clean))
  const tpl = fallbackTemplate.includes('{tracking}') ? fallbackTemplate : TPC_TRACK_URL
  return tpl.replace('{tracking}', encodeURIComponent(clean))
}

/** ST Courier only tracks by typing the AWB, so show the AWB with a Copy button and a link there. */
export function stTrackingPage(awb: string): string {
  const safe = trackingSlug(awb)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Track your parcel – ST Courier</title>
<style>body{font-family:system-ui,sans-serif;background:#fbf3e4;color:#1d1d1d;margin:0;padding:32px 16px;text-align:center}
.card{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 4px;color:#9b1c31}.awb{font-size:28px;font-weight:700;letter-spacing:2px;margin:16px 0}
a,button{display:block;width:100%;box-sizing:border-box;padding:14px;border-radius:10px;font-size:16px;font-weight:600;margin-top:10px;text-decoration:none;cursor:pointer}
button{background:#fff;color:#9b1c31;border:2px solid #9b1c31}a{background:#9b1c31;color:#fff;border:0}p{color:#666;font-size:14px}</style></head>
<body><div class="card"><h1>Shanthi Boutique</h1><p>Your parcel is with <b>ST Courier</b>. AWB number:</p>
<div class="awb" id="awb">${safe}</div>
<button id="copy">Copy AWB number</button>
<a href="${ST_TRACK_URL}">Track on ST Courier</a>
<p>On the ST Courier page, paste the AWB number and tap Search.</p></div>
<script>document.getElementById("copy").onclick=function(){navigator.clipboard.writeText("${safe}").then(function(){document.getElementById("copy").textContent="Copied ✓"})}</script>
</body></html>`
}
