import { describe, expect, it } from 'vitest'
import { initialOf } from './initial'

describe('initialOf', () => {
  it('uppercases a plain first letter', () => {
    expect(initialOf('renuraj')).toBe('R')
  })

  it('keeps a whole astral character instead of half a surrogate pair', () => {
    expect(initialOf('😀 Smile')).toBe('😀')
  })

  it('folds fancy mathematical letters to plain ones', () => {
    expect(initialOf('𝚁𝚎𝚗𝚞𝚛𝚊𝚓')).toBe('R')
    expect(initialOf('𝐀sha')).toBe('A')
  })

  it('ignores leading whitespace and falls back when empty', () => {
    expect(initialOf('  kala')).toBe('K')
    expect(initialOf('')).toBe('?')
    expect(initialOf(null, '#')).toBe('#')
  })
})
