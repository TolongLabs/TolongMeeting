// Scripts whose words are not separated by spaces.
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
// Marks after these letters are accents (é, ö, ñ, Ё). After any other script they are vowels or voicing (Devanagari
// ि, Thai ิ, kana ゛) and change the word, so they stay.
const ACCENTED = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu

/** Letters a spaced-script name needs before a member's mention alert may watch for it. */
export const MIN_SPACED_NAME_LETTERS = 3
/** Letters a name in a script written without spaces (Chinese, Japanese, Thai, ...) needs. */
export const MIN_UNSPACED_NAME_LETTERS = 2

// A name as people compare it: no Latin, Greek or Cyrillic accents, no case or punctuation, "ß" as "ss", single
// spaces between words. Combining marks of other scripts are part of their letters and are kept.
export function normaliseName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(ACCENTED, '$1')
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .normalize('NFC')
}

/** Whether a normalised name is in a script whose words run together (so it is matched inside the text). */
export function isUnspacedName(normalised: string): boolean {
  return UNSPACED.test(normalised)
}

/** Whether a mention alert may watch for this name: enough letters (3 in spaced scripts, 2 in unspaced ones). */
export function isWatchableName(name: string): boolean {
  const normalised = normaliseName(name)
  const letters = [...normalised.replace(/[^\p{L}\p{N}]+/gu, '')].length
  return letters >= (isUnspacedName(normalised) ? MIN_UNSPACED_NAME_LETTERS : MIN_SPACED_NAME_LETTERS)
}
