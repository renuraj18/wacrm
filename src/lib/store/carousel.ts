// ============================================================
// WhatsApp carousel ("swipeable cards") message: 2–10 cards, each with a
// photo, up to 160 characters of text and the same number of quick-reply
// buttons. Meta rejects a carousel whose cards have different button counts.
// Port of the relay's buildReplyPayload carousel branch (whatsapp.js).
// ============================================================

export interface CarouselCard {
  /** Photo: a WhatsApp media id or an https link. */
  image: { id: string } | { link: string }
  text?: string
  /** Quick-reply buttons (id) or one link button (url). A card uses one kind throughout. */
  buttons: CarouselButton[]
}

export type CarouselButton = { id: string; title: string } | { url: string; title: string }

export const CAROUSEL_MIN_CARDS = 2
export const CAROUSEL_MAX_CARDS = 10
export const CAROUSEL_CARD_TEXT_MAX = 160
export const CAROUSEL_BUTTON_TITLE_MAX = 20
export const CAROUSEL_BODY_MAX = 1024

/** Builds the Meta payload. Throws when the cards would be rejected. */
export function buildCarouselPayload(to: string, bodyText: string, cards: CarouselCard[]): Record<string, unknown> {
  if (cards.length < CAROUSEL_MIN_CARDS || cards.length > CAROUSEL_MAX_CARDS) {
    throw new Error(`A carousel needs ${CAROUSEL_MIN_CARDS}–${CAROUSEL_MAX_CARDS} cards (got ${cards.length})`)
  }
  const buttonCount = cards[0].buttons.length
  if (buttonCount < 1) throw new Error('Each carousel card needs at least one button')
  for (const [i, c] of cards.entries()) {
    if (c.buttons.length !== buttonCount) {
      throw new Error(`Card ${i + 1} has ${c.buttons.length} buttons; every card needs ${buttonCount}`)
    }
  }
  const linkCard = cards.every((c) => c.buttons.length === 1 && 'url' in c.buttons[0])
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'carousel',
      body: { text: bodyText.slice(0, CAROUSEL_BODY_MAX) },
      action: {
        cards: cards.map((c, i) => ({
          card_index: i,
          type: 'cta_url',
          header: { type: 'image', image: c.image },
          ...(c.text ? { body: { text: c.text.slice(0, CAROUSEL_CARD_TEXT_MAX) } } : {}),
          // A link card has one CTA URL button: action.name "cta_url" with its parameters.
          // Quick-reply cards list their buttons instead. Meta doesn't allow the two mixed.
          action: linkCard
            ? {
                name: 'cta_url',
                parameters: {
                  display_text: c.buttons[0].title.slice(0, CAROUSEL_BUTTON_TITLE_MAX),
                  url: (c.buttons[0] as { url: string }).url,
                },
              }
            : {
                buttons: c.buttons.map((b) => ({
                  type: 'quick_reply',
                  quick_reply: { id: (b as { id: string }).id.slice(0, 256), title: b.title.slice(0, CAROUSEL_BUTTON_TITLE_MAX) },
                })),
              },
        })),
      },
    },
  }
}
