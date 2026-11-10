import { describe, expect, it } from 'vitest'

import { buildCarouselPayload, type CarouselCard } from './carousel'

const card = (n: number, buttons = 2): CarouselCard => ({
  image: { link: `https://img.example/${n}.jpg` },
  text: `*Saree ${n}*\n₹850`,
  buttons: Array.from({ length: buttons }, (_, i) => ({ id: `s:a:${n}:${i}`, title: `Button ${i}` })),
})

describe('buildCarouselPayload', () => {
  it('builds the carousel the relay sent (cta_url cards with quick-reply buttons)', () => {
    const p = buildCarouselPayload('919632982245', 'Here are the sarees', [card(1), card(2)]) as {
      interactive: { type: string; action: { cards: { card_index: number; type: string; action: { buttons: unknown[] } }[] } }
    }
    expect(p.interactive.type).toBe('carousel')
    expect(p.interactive.action.cards.map((c) => c.card_index)).toEqual([0, 1])
    expect(p.interactive.action.cards[0].type).toBe('cta_url')
    expect(p.interactive.action.cards[0].action.buttons).toEqual([
      { type: 'quick_reply', quick_reply: { id: 's:a:1:0', title: 'Button 0' } },
      { type: 'quick_reply', quick_reply: { id: 's:a:1:1', title: 'Button 1' } },
    ])
  })

  it('refuses fewer than 2 or more than 10 cards', () => {
    expect(() => buildCarouselPayload('1', 'x', [card(1)])).toThrow('2–10 cards')
    const eleven = Array.from({ length: 11 }, (_, i) => card(i))
    expect(() => buildCarouselPayload('1', 'x', eleven)).toThrow('2–10 cards')
  })

  it('refuses cards with different button counts', () => {
    expect(() => buildCarouselPayload('1', 'x', [card(1, 2), card(2, 1)])).toThrow('every card needs 2')
  })

  it('caps text, body and button titles to Meta limits', () => {
    const long: CarouselCard = {
      image: { id: 'media-1' },
      text: 'x'.repeat(400),
      buttons: [{ id: 'b', title: 'y'.repeat(40) }],
    }
    const p = buildCarouselPayload('1', 'z'.repeat(2000), [long, card(2, 1)]) as {
      interactive: { body: { text: string }; action: { cards: { body: { text: string }; action: { buttons: { quick_reply: { title: string } }[] } }[] } }
    }
    expect(p.interactive.body.text.length).toBe(1024)
    expect(p.interactive.action.cards[0].body.text.length).toBe(160)
    expect(p.interactive.action.cards[0].action.buttons[0].quick_reply.title.length).toBe(20)
  })

  it('a link button becomes a Buy Now call-to-action on the card', () => {
    const linkCard: CarouselCard = {
      image: { link: 'https://img.example/1.jpg' },
      text: '*Trending Kolam Saree*\n₹650',
      buttons: [{ url: 'https://shanthiboutique.com/products/trending-kolam-saree', title: 'Buy Now' }],
    }
    const p = buildCarouselPayload('919632982245', 'Here are the sarees', [linkCard, linkCard]) as {
      interactive: { action: { cards: { action: { buttons: unknown[] } }[] } }
    }
    expect(p.interactive.action.cards[0].action.buttons).toEqual([
      { type: 'cta_url', cta_url: { display_text: 'Buy Now', url: 'https://shanthiboutique.com/products/trending-kolam-saree' } },
    ])
  })
})
