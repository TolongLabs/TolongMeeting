import type { AsrResult } from '@tm/ai'
import { normaliseName } from '@tm/core'

// A member's name, as they entered it, with its normalised words. Matching compares the words only.
export type CompiledName = { name: string; tokens: string[] }

function words(normalised: string): string[] {
  return normalised === '' ? [] : normalised.split(' ')
}

// Drops names shorter than 2 characters after normalisation, and repeats of a name that normalises the same way.
export function compileNames(names: string[]): CompiledName[] {
  const seen = new Set<string>()
  const compiled: CompiledName[] = []
  for (const name of names) {
    const normalised = normaliseName(name)
    if ([...normalised].length < 2 || seen.has(normalised)) continue
    seen.add(normalised)
    compiled.push({ name: name.trim().replace(/\s+/g, ' '), tokens: words(normalised) })
  }
  return compiled
}

function containsRun(spoken: string[], run: string[]): boolean {
  for (let i = 0; i + run.length <= spoken.length; i++) {
    if (run.every((word, j) => spoken[i + j] === word)) return true
  }
  return false
}

// Whole words only: "Ali" does not match "Alice" or "Aliyah". Returns the longest matching name, or null.
export function findMention(text: string, names: CompiledName[]): string | null {
  const spoken = words(normaliseName(text))
  let best: CompiledName | null = null
  for (const candidate of names) {
    if (best !== null && candidate.tokens.join(' ').length <= best.tokens.join(' ').length) continue
    if (containsRun(spoken, candidate.tokens)) best = candidate
  }
  return best?.name ?? null
}

// The transcript of the last spanMs, from results that overlap that span. Text longer than maxChars keeps its end.
export function transcriptWindow(results: AsrResult[], endMs: number, spanMs = 30_000, maxChars = 1_500): string {
  const joined = results
    .filter((r) => r.endMs > endMs - spanMs && r.startMs <= endMs)
    .map((r) => r.text.trim())
    .filter((text) => text !== '')
    .join(' ')
  const chars = [...joined]
  if (chars.length <= maxChars) return joined
  return `…${chars.slice(-(maxChars - 1)).join('')}`
}
