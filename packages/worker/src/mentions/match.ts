import type { AsrResult } from '@tm/ai'
import { isUnspacedName, isWatchableName, normaliseName } from '@tm/core'

// A member's name, as they entered it, with its normalised words. A spaced-script name matches by its words; a name in
// a script written without spaces (Chinese, Japanese, Thai, Lao, Khmer, Myanmar) matches as text inside the spoken
// text, where `compact` is the name without spaces.
export type CompiledName = { name: string; tokens: string[]; compact: string | null }

function words(normalised: string): string[] {
  return normalised === '' ? [] : normalised.split(' ')
}

const withoutSpaces = (normalised: string): string => normalised.replaceAll(' ', '')

// Drops names with too few letters to watch (see `isWatchableName`: 3 in spaced scripts, 2 in the others), and repeats
// of a name that normalises the same way.
export function compileNames(names: string[]): CompiledName[] {
  const seen = new Set<string>()
  const compiled: CompiledName[] = []
  for (const name of names) {
    const normalised = normaliseName(name)
    if (!isWatchableName(name) || seen.has(normalised)) continue
    seen.add(normalised)
    compiled.push({
      name: name.trim().replace(/\s+/g, ' '),
      tokens: words(normalised),
      compact: isUnspacedName(normalised) ? withoutSpaces(normalised) : null
    })
  }
  return compiled
}

function containsRun(spoken: string[], run: string[]): boolean {
  for (let i = 0; i + run.length <= spoken.length; i++) {
    if (run.every((word, j) => spoken[i + j] === word)) return true
  }
  return false
}

// Spaced scripts: whole words only ("Ali" does not match "Alice" or "Aliyah"). Scripts written without spaces: the name
// anywhere in the text ("王伟" in "王伟你怎么看"). Returns the longest matching name, or null.
export function findMention(text: string, names: CompiledName[]): string | null {
  const normalised = normaliseName(text)
  const spoken = words(normalised)
  const compactText = withoutSpaces(normalised)
  let best: CompiledName | null = null
  for (const candidate of names) {
    if (best !== null && candidate.tokens.join(' ').length <= best.tokens.join(' ').length) continue
    const found =
      candidate.compact !== null ? compactText.includes(candidate.compact) : containsRun(spoken, candidate.tokens)
    if (found) best = candidate
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
