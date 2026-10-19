// Corrects proper nouns in transcript text against authoritative vocabulary (slide text, timetable entry).
// A run of words close to a term becomes the term, and the words as heard stay in a note, so no guess is silent.

const MIN_TERM_LETTERS = 6
const LONG_TERM_LETTERS = 10

interface Term {
  text: string
  words: number
  letters: number
}

interface Span {
  start: number
  end: number
}

interface Match {
  term: Term
  heard: string
  start: number
  end: number
  words: number
}

const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]+/u
const TRAILING_PUNCTUATION = /[^\p{L}\p{N}]+$/u

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length
}

function vocabularyTerms(vocab: string[]): Term[] {
  const seen = new Set<string>()
  const terms: Term[] = []
  for (const raw of vocab) {
    const text = raw.trim().replace(/\s+/g, ' ')
    const letters = letterCount(text)
    if (letters < MIN_TERM_LETTERS || seen.has(text)) continue
    seen.add(text)
    terms.push({ text, words: text.split(' ').length, letters })
  }
  return terms
}

function maxDistance(term: Term): number {
  return term.letters >= LONG_TERM_LETTERS ? 2 : 1
}

function wordSpans(text: string): Span[] {
  const spans: Span[] = []
  const pattern = /\S+/g
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    spans.push({ start: m.index, end: m.index + m[0].length })
  }
  return spans
}

// Optimal string alignment is not enough here: this is the unrestricted Damerau-Levenshtein distance.
function damerauLevenshtein(a: string, b: string): number {
  const n = a.length
  const m = b.length
  const maxDist = n + m
  const h: number[][] = Array.from({ length: n + 2 }, () => new Array<number>(m + 2).fill(0))
  h[0][0] = maxDist
  for (let i = 0; i <= n; i++) {
    h[i + 1][0] = maxDist
    h[i + 1][1] = i
  }
  for (let j = 0; j <= m; j++) {
    h[0][j + 1] = maxDist
    h[1][j + 1] = j
  }
  const lastRowOf = new Map<string, number>()
  for (let i = 1; i <= n; i++) {
    let lastMatchCol = 0
    for (let j = 1; j <= m; j++) {
      const k = lastRowOf.get(b[j - 1]) ?? 0
      const l = lastMatchCol
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      if (cost === 0) lastMatchCol = j
      h[i + 1][j + 1] = Math.min(
        h[i][j] + cost,
        h[i + 1][j] + 1,
        h[i][j + 1] + 1,
        h[k][l] + (i - k - 1) + 1 + (j - l - 1)
      )
    }
    lastRowOf.set(a[i - 1], i)
  }
  return h[n + 1][m + 1]
}

// Punctuation inside a window ("Dr.", "Kuber-netes") does not count toward the distance.
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function closestTerm(heard: string, terms: Term[], words: number): { term: Term } | null {
  const lower = comparable(heard)
  let best: { term: Term; distance: number } | null = null
  for (const term of terms) {
    if (term.words !== words) continue
    const target = comparable(term.text)
    if (Math.abs(target.length - lower.length) > maxDistance(term)) continue
    const distance = damerauLevenshtein(lower, target)
    if (distance > maxDistance(term)) continue
    if (best === null || distance < best.distance) best = { term, distance }
  }
  return best
}

function matchAt(text: string, spans: Span[], i: number, terms: Term[], maxWords: number): Match | null {
  for (let words = Math.min(maxWords, spans.length - i); words >= 1; words--) {
    const first = spans[i]
    const last = spans[i + words - 1]
    const start = first.start + (text.slice(first.start, first.end).match(LEADING_PUNCTUATION)?.[0].length ?? 0)
    const end = last.end - (text.slice(last.start, last.end).match(TRAILING_PUNCTUATION)?.[0].length ?? 0)
    if (end <= start) continue
    const heard = text.slice(start, end).split(/\s+/).join(' ')
    const closest = closestTerm(heard, terms, words)
    if (closest !== null) return { term: closest.term, heard, start, end, words }
  }
  return null
}

export function correctNames(text: string, vocab: string[]): string {
  const terms = vocabularyTerms(vocab)
  if (terms.length === 0) return text
  const spans = wordSpans(text)
  const maxWords = Math.max(...terms.map((term) => term.words))
  const pieces: string[] = []
  let cursor = 0
  let i = 0
  while (i < spans.length) {
    const match = matchAt(text, spans, i, terms, maxWords)
    if (match === null) {
      i++
      continue
    }
    if (match.heard !== match.term.text) {
      pieces.push(text.slice(cursor, match.start), `${match.term.text} _(as heard: "${match.heard}")_`)
      cursor = match.end
    }
    i += match.words
  }
  pieces.push(text.slice(cursor))
  return pieces.join('')
}
