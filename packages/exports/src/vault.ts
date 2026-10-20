// Sealing lives in the web package (`sealColumn` / `openColumn`, bound to member and column). This file only cleans
// text: an error message from a provider can quote the token we sent, and it is stored and shown to the member.

const MARK = '[redacted]'
const MIN_SECRET_LENGTH = 8

// Token shapes: GitHub (`github_pat_`, `ghp_` ...), Google access (`ya29.`) and refresh (`1//`), Notion (`ntn_`, `secret_`).
const TOKEN = /github_pat_\w+|\bgh[opsu]_\w+|\bya29\.[\w.-]+|(?<![\w/])1\/\/[\w-]+|\bntn_\w+|\bsecret_\w+/g
// `Bearer <value>`: the value goes, the word stays.
const BEARER = /\b(Bearer\s+)[\w.~+/=-]+/gi
// `scheme://user:pass@host/...` or `scheme://token@host/...`: the whole URL goes.
const URL_WITH_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@[^\s'")>]*/gi
// A credential in a query string or form body.
const CREDENTIAL_PARAM = /\b((?:access_token|refresh_token|id_token|client_secret|api_key|apikey|token)=)[^&\s'")>]+/gi

/**
 * Removes secrets from text before it is stored or logged: each of `secrets` (those of 8 or more characters), bearer
 * values, URLs that carry a user name or password, credential query parameters and known token shapes. Each becomes
 * `[redacted]`.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  // Longest first, so a secret that contains another one is removed whole.
  for (const secret of [...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(MARK)
  }
  return out
    .replace(URL_WITH_CREDENTIALS, MARK)
    .replace(BEARER, `$1${MARK}`)
    .replace(CREDENTIAL_PARAM, `$1${MARK}`)
    .replace(TOKEN, MARK)
}
