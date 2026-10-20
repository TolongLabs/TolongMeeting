// Sealing lives in the web package (`sealColumn` / `openColumn`, bound to member and column). This file only cleans
// text: an error message from a provider can quote the token we sent, and it is stored and shown to the member.
//
// The text can be long and is attacker-influenced (a provider's error body), so every pattern here is non-backtracking:
// each repetition is a single character class that cannot overlap the next piece, and the input is cut to MAX_INPUT
// first. Nothing here is quadratic.

const MARK = '[redacted]'
const MIN_SECRET_LENGTH = 8
/** Text past this many characters is cut before matching. An error message never needs more. */
export const MAX_REDACT_INPUT = 8 * 1024
const CUT_NOTE = '[truncated]'

// The names a credential can have in a header, a form body or JSON. `x-api-key` is the common header spelling; the
// key may be quoted (`"password": ...`), as it is in JSON.
const CREDENTIAL_KEYS =
  'client_secret|access_token|refresh_token|id_token|api_key|apikey|api-key|x-api-key|password|secret|token|passcode|pwd'
const CREDENTIAL_KEY = String.raw`(?:"(?:${CREDENTIAL_KEYS})"|\b(?:${CREDENTIAL_KEYS}))`
// A percent-encoded octet. A token body accepts one in place of a character, so a URL-encoded token goes whole.
const PERCENT = String.raw`%[0-9A-Fa-f]{2}`
const TOKEN_BODY = String.raw`(?:[\w.-]|${PERCENT})+`
const WORD_BODY = String.raw`(?:[\w-]|${PERCENT})+`
// Token shapes: GitHub (`github_pat_`, `ghp_` ...), Google access (`ya29.`), refresh (`1//`), API key (`AIza`) and
// client secret (`GOCSPX-`), Notion (`ntn_`, `secret_`).
const TOKEN = new RegExp(
  String.raw`github_pat_${TOKEN_BODY}|\bgh[opsu]_${TOKEN_BODY}|\bya29\.${TOKEN_BODY}|(?<![\w/])1\/\/${WORD_BODY}|\bAIza[\w-]{20,}|\bGOCSPX-${WORD_BODY}|\bntn_${TOKEN_BODY}|\bsecret_${TOKEN_BODY}`,
  'g'
)
// `Bearer <value>`, `Basic <value>` and `Token <value>`: the value goes, the word stays, and any run of whitespace
// between them (a line break included) becomes one space.
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[\w.~+/=-]+/gi
// `scheme://user:pass@host/...` or `scheme://token@host/...`: the whole URL goes.
const URL_WITH_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@[^\s'")>]*/gi
// A credential in a query string or form body.
const CREDENTIAL_PARAM =
  /\b((?:access_token|refresh_token|id_token|client_secret|api_key|apikey|password|secret|signature|token|code|key|sig)=)[^&\s'")>]+/gi
// A credential in JSON: "client_secret": "value" (the key stays, the value goes).
const JSON_CREDENTIAL =
  /("(?:client_secret|access_token|refresh_token|id_token|api_key|apikey|password|secret|token)"\s*:\s*")(?:[^"\\]|\\.)*"/gi
// A credential in single quotes: password: 'value'.
const SINGLE_QUOTED_CREDENTIAL = new RegExp(String.raw`(${CREDENTIAL_KEY}\s*:\s*')(?:[^'\\]|\\.)*'`, 'gi')
// A JSON credential with a number for a value: "token": 12345678.
const JSON_NUMERIC_CREDENTIAL = new RegExp(
  String.raw`("(?:${CREDENTIAL_KEYS})"\s*:\s*)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`,
  'gi'
)
// A credential with no quotes at all: password: value, x-api-key: value.
const BARE_CREDENTIAL = new RegExp(String.raw`(${CREDENTIAL_KEY}\s*:\s*)[^\s,;&}'"()<>]+`, 'gi')

/**
 * Removes secrets from text before it is stored or logged: each of `secrets` (those of 8 or more characters, also when
 * URL-encoded or split by a line break), bearer, basic and Token values, URLs that carry a user name or password,
 * credential query parameters, JSON and single-quoted and bare credential fields, and known token shapes. Each becomes
 * `[redacted]`. Input over 8 KB is cut (at a word boundary) before the patterns run, so their cost is bounded.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  // Longest first, so a secret that contains another one is removed whole. Plain string search: linear.
  for (const secret of [...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(MARK)
    out = out.replace(encodedPattern(secret), MARK)
    out = out.replace(lineBreakPattern(secret), MARK)
  }
  return cut(out)
    .replace(URL_WITH_CREDENTIALS, MARK)
    .replace(JSON_CREDENTIAL, `$1${MARK}"`)
    .replace(SINGLE_QUOTED_CREDENTIAL, `$1${MARK}'`)
    .replace(JSON_NUMERIC_CREDENTIAL, `$1${MARK}`)
    .replace(BARE_CREDENTIAL, `$1${MARK}`)
    .replace(AUTH_SCHEME, `$1 ${MARK}`)
    .replace(CREDENTIAL_PARAM, `$1${MARK}`)
    .replace(TOKEN, MARK)
}

/** `secret` with each character also accepted as its percent-encoded octets, so a URL-encoded token is removed whole. */
function encodedPattern(secret: string): RegExp {
  const source = Array.from(secret, (char) => {
    const encoded = Array.from(new TextEncoder().encode(char), (byte) => {
      return `%${hexDigit(byte >> 4)}${hexDigit(byte & 15)}`
    }).join('')
    return `(?:${escapePattern(char)}|${encoded})`
  }).join('')
  return new RegExp(source, 'g')
}

/** `secret` with a line break allowed between any two characters, so a wrapped token is removed whole. */
function lineBreakPattern(secret: string): RegExp {
  return new RegExp(Array.from(secret, escapePattern).join(String.raw`(?:\r?\n)?`), 'g')
}

/** A literal character for a regular expression. */
function escapePattern(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One hex digit that matches either case, so `%2f` and `%2F` both match. */
function hexDigit(nibble: number): string {
  const digit = nibble.toString(16)
  return /[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit
}

/** At most `MAX_REDACT_INPUT` characters, cut back to the last whitespace so a half token is never left behind. */
function cut(text: string): string {
  if (text.length <= MAX_REDACT_INPUT) return text
  let end = MAX_REDACT_INPUT
  while (end > 0 && !/\s/.test(text.charAt(end - 1))) end--
  return text.slice(0, end) + CUT_NOTE
}
