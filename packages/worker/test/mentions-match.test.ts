import { expect, test } from 'bun:test'
import { compileNames, findMention, transcriptWindow } from '../src/mentions/match'

const names = compileNames(['Nur Aisyah', 'Aisyah', 'Zoë', 'A', '  '])

test('names compile once each; one-letter and blank names are dropped', () => {
  expect(names.map((n) => n.tokens)).toEqual([['nur', 'aisyah'], ['aisyah'], ['zoe']])
})

test('repeats of a name that normalises the same way compile once', () => {
  const repeated = compileNames(['Aisyah', ' aisyah ', 'AISYAH', 'Aisyah!'])
  expect(repeated.map((n) => n.name)).toEqual(['Aisyah'])
})

test.each([
  ['Aisyah, can you answer the next one?', 'Aisyah'],
  ['Thank you, Nur-Aisyah.', 'Nur Aisyah'],
  ['AISYAH?', 'Aisyah'],
  ['zoe is next', 'Zoë'],
  ['ZOË is next', 'Zoë'],
  ['Aisyahrani will present', null],
  ['Nurul will present', null],
  ['', null]
])('findMention(%p) is %p', (text, want) => expect(findMention(text, names)).toBe(want)) // Review Focus

test.each([
  ['Alice, come up please', null],
  ['Aliyah and Alice', null],
  ['Mohd Ali', 'Ali'],
  ['Ali', 'Ali']
])('a name matches only as a whole word: findMention(%p) is %p', (text, want) =>
  expect(findMention(text, compileNames(['Ali']))).toBe(want)
)

test('the words of a name must appear together and in order', () => {
  expect(findMention('Nur is here and Aisyah is there', names)).toBe('Aisyah')
  expect(findMention('Aisyah Nur, your turn', compileNames(['Nur Aisyah']))).toBeNull()
  expect(findMention('Nur, then Aisyah', compileNames(['Nur Aisyah']))).toBeNull()
})

test('a name in a longer name is not matched by its shorter part', () => {
  expect(findMention('Nurul Aisyah will present', compileNames(['Nur Aisyah']))).toBeNull()
  expect(findMention('Nur Aisyahrani', compileNames(['Nur Aisyah']))).toBeNull()
})

test('the longest matching name wins, whatever the list order', () => {
  expect(findMention('Nur Aisyah, go on', compileNames(['Aisyah', 'Nur Aisyah']))).toBe('Nur Aisyah')
  expect(findMention('Nur Aisyah, go on', compileNames(['Nur Aisyah', 'Aisyah']))).toBe('Nur Aisyah')
})

test('accents are ignored in both directions', () => {
  expect(findMention('Jose, you are up', compileNames(['José']))).toBe('José')
  expect(findMention('José, you are up', compileNames(['Jose']))).toBe('Jose')
})

test('Chinese names written without spaces match as a whole run only', () => {
  const chinese = compileNames(['陈伟明'])
  expect(findMention('陈伟明, 请回答', chinese)).toBe('陈伟明')
  expect(findMention('陈伟明同学请回答', chinese)).toBeNull()
})

test('a romanised Chinese name matches across a hyphen', () => {
  expect(findMention('Wei-Ming, next question', compileNames(['Tan Wei Ming']))).toBeNull()
  expect(findMention('Wei-Ming, next question', compileNames(['Wei Ming']))).toBe('Wei Ming')
})

test('the window holds the last 30 seconds, cut from the front', () => {
  const rs = [
    { startMs: 0, endMs: 10_000, text: 'one' },
    { startMs: 10_000, endMs: 25_000, text: 'two' },
    { startMs: 25_000, endMs: 40_000, text: 'three' },
    { startMs: 40_000, endMs: 52_000, text: 'Aisyah?' }
  ]
  expect(transcriptWindow(rs, 52_000)).toBe('two three Aisyah?')
  const long = transcriptWindow([{ startMs: 0, endMs: 1_000, text: 'x'.repeat(2_000) }], 1_000)
  expect([long.length, long[0]]).toEqual([1_500, '…'])
})

test('a result that ends exactly at the window start is left out', () => {
  const rs = [
    { startMs: 0, endMs: 22_000, text: 'edge' },
    { startMs: 22_000, endMs: 23_000, text: 'inside' }
  ]
  expect(transcriptWindow(rs, 52_000)).toBe('inside')
})

test('a result that starts after the window end is left out', () => {
  const rs = [
    { startMs: 0, endMs: 5_000, text: 'before' },
    { startMs: 60_000, endMs: 61_000, text: 'later' }
  ]
  expect(transcriptWindow(rs, 5_000)).toBe('before')
})

test('empty results are skipped and text is trimmed before joining', () => {
  const rs = [
    { startMs: 0, endMs: 1_000, text: '  hello ' },
    { startMs: 1_000, endMs: 2_000, text: '   ' },
    { startMs: 2_000, endMs: 3_000, text: 'there ' }
  ]
  expect(transcriptWindow(rs, 3_000)).toBe('hello there')
})
