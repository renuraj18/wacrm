/**
 * First character of a name for an avatar fallback.
 *
 * `name.charAt(0)` returns half of a surrogate pair for any character
 * outside the BMP — emoji, and the "fancy" mathematical letters many
 * WhatsApp profile names use (𝐑𝐞𝐧𝐮, 𝚁𝚎𝚗𝚞) — which renders as "�". Take a
 * whole code point instead, and fold compatibility forms to plain letters
 * (NFKC turns 𝚁 into R) so the avatar reads naturally.
 */
export function initialOf(name: string | null | undefined, fallback = '?'): string {
  const first = Array.from((name ?? '').trim())[0]
  if (!first) return fallback
  return first.normalize('NFKC').toUpperCase()
}
