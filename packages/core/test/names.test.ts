import { expect, test } from 'bun:test'
import { normaliseName } from '../src/index'

test('names compare without case, accents or punctuation', () => {
  expect(normaliseName('  Nur-AISYAH binti Ahmad ')).toBe('nur aisyah binti ahmad')
  expect(normaliseName('Zoë')).toBe('zoe')
  expect(normaliseName("O'Neil, J.")).toBe('o neil j')
})
