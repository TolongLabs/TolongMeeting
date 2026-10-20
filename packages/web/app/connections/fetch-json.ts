// The browser side of the connection routes. The routes answer with fixed sentences in `message`, so a refusal can be
// shown as it is; anything else becomes one of the sentences below. Nothing here reads or keeps a token.

export const GENERIC_PROBLEM = 'That did not work. Try again.'

/** A refusal with a sentence the member can read. */
export class Refused extends Error {}

async function messageOf(response: Response): Promise<string> {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return GENERIC_PROBLEM
  const body: unknown = await response.json()
  if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string')
    return body.message
  return GENERIC_PROBLEM
}

/** The JSON of a successful answer. A refused one throws `Refused` with the route's sentence. */
export async function okJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Refused(await messageOf(response))
  return response.json()
}

/** Sends `body` as JSON with `PUT` to a same-origin route; a refusal throws `Refused`. */
export async function putJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  await okJson(response)
}

/** Reads a same-origin route that must never be cached. */
export async function getJson(url: string): Promise<unknown> {
  return okJson(await fetch(url, { cache: 'no-store' }))
}
