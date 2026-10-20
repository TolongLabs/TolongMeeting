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

// Token shapes: GitHub (`github_pat_`, `ghp_` ...), Google access (`ya29.`), refresh (`1//`), API key (`AIza`) and
// client secret (`GOCSPX-`), Notion (`ntn_`, `secret_`).
const TOKEN =
  /github_pat_\w+|\bgh[opsu]_\w+|\bya29\.[\w.-]+|(?<![\w/])1\/\/[\w-]+|\bAIza[\w-]{20,}|\bGOCSPX-[\w-]+|\bntn_\w+|\bsecret_\w+/g
// `Bearer <value>` and `Basic <value>`: the value goes, the word stays.
const AUTH_SCHEME = /\b((?:Bearer|Basic)\s+)[\w.~+/=-]+/gi
// `scheme://user:pass@host/...` or `scheme://token@host/...`: the whole URL goes.
const URL_WITH_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@[^\s'")>]*/gi
// A credential in a query string or form body.
const CREDENTIAL_PARAM =
  /\b((?:access_token|refresh_token|id_token|client_secret|api_key|apikey|password|secret|signature|token|code|key|sig)=)[^&\s'")>]+/gi
// A credential in JSON: "client_secret": "value" (the key stays, the value goes).
const JSON_CREDENTIAL =
  /("(?:client_secret|access_token|refresh_token|id_token|api_key|apikey|password|secret|token)"\s*:\s*")(?:[^"\\]|\\.)*"/gi

/**
 * Removes secrets from text before it is stored or logged: each of `secrets` (those of 8 or more characters), bearer and
 * basic values, URLs that carry a user name or password, credential query parameters, JSON credential fields and known
 * token shapes. Each becomes `[redacted]`. Input over 8 KB is cut (at a word boundary) before the patterns run, so their cost is bounded.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  // Longest first, so a secret that contains another one is removed whole. Plain string search: linear.
  for (const secret of [...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(MARK)
  }
  return cut(out)
    .replace(URL_WITH_CREDENTIALS, MARK)
    .replace(JSON_CREDENTIAL, `$1${MARK}"`)
    .replace(AUTH_SCHEME, `$1${MARK}`)
    .replace(CREDENTIAL_PARAM, `$1${MARK}`)
    .replace(TOKEN, MARK)
}

/** At most `MAX_REDACT_INPUT` characters, cut back to the last whitespace so a half token is never left behind. */
function cut(text: string): string {
  if (text.length <= MAX_REDACT_INPUT) return text
  let end = MAX_REDACT_INPUT
  while (end > 0 && !/\s/.test(text.charAt(end - 1))) end--
  return text.slice(0, end) + CUT_NOTE
}
