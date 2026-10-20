import { expect, test } from 'bun:test'
import { isWatchableName, normaliseName } from '../src/index'

test('names compare without case, accents or punctuation', () => {
  expect(normaliseName('  Nur-AISYAH binti Ahmad ')).toBe('nur aisyah binti ahmad')
  expect(normaliseName('Zoë')).toBe('zoe')
  expect(normaliseName("O'Neil, J.")).toBe('o neil j')
})

test('accents of Latin, Greek and Cyrillic are dropped; the marks of other scripts are letters and stay', () => {
  expect(normaliseName('Ömer ÁÉ Ñandú')).toBe('omer ae nandu')
  expect(normaliseName('Ἀθηνᾶ')).toBe('αθηνα')
  expect(normaliseName('Йоханнес')).toBe('иоханнес')
  // Devanagari: the vowel sign makes a different name, and the word stays one word.
  expect(normaliseName('किरण')).toBe('किरण')
  expect(normaliseName('किरण')).not.toBe(normaliseName('करण'))
  expect(normaliseName('சுந்தர்')).toBe('சுந்தர்')
  expect(normaliseName('สมชาย')).toBe('สมชาย')
  expect(normaliseName('ガク')).not.toBe(normaliseName('カク'))
  expect(normaliseName('বাংলা নাম')).toBe('বাংলা নাম')
})

test('"ß" folds to "ss"', () => {
  expect(normaliseName('Weiß')).toBe('weiss')
  expect(normaliseName('STRAẞE')).toBe('strasse')
})

test('a name is watchable with 3 letters in a spaced script and 2 in an unspaced one', () => {
  for (const ok of ['Ali', 'Zoë', 'Nur Aisyah', '王伟', 'タナカ', 'สมชาย', 'किरण'])
    expect(isWatchableName(ok), ok).toBe(true)
  for (const no of ['', 'Li', 'Al', 'J.R.', '  A ', '李', '😀😀😀', '!!']) expect(isWatchableName(no), no).toBe(false)
})
