import { SigninReplySchema, type SigninHeartbeat, type SigninReply } from '@tm/core'
import { controlEndpoint } from '../control/heartbeat'

const TIMEOUT_MS = 4_000
/** A reply body larger than this is refused unread (a real reply is a few dozen bytes). */
const MAX_REPLY_BYTES = 16 * 1024

// The reply body as text, or null when it is longer than the cap (nothing is read past it).
async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Posts a sign-in heartbeat to `<control.url>/signin` with the control token as the bearer, and returns the reply. The
 * token goes only in that header. Every failure throws an error with a fixed message: the URL and the token are never
 * in it.
 */
export function signinPoster(
  control: { url: string; token: string },
  fetchFn: typeof fetch = fetch
): (hb: SigninHeartbeat) => Promise<SigninReply> {
  const url = controlEndpoint(control.url, 'signin')
  return async (hb) => {
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${control.token}` },
        body: JSON.stringify(hb),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error'
      })
    } catch (error) {
      throw new Error(`the sign-in report was not delivered (${error instanceof Error ? error.name : 'error'})`)
    }
    if (!response.ok) throw new Error(`the sign-in report was refused (${response.status})`)
    const text = await readCapped(response)
    if (text === null) throw new Error('the sign-in reply is too long')
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error('the sign-in reply is not JSON')
    }
    const parsed = SigninReplySchema.safeParse(json)
    if (!parsed.success) throw new Error('the sign-in reply is not valid')
    return parsed.data
  }
}
