const ANY_HOST_PARAMS: ReadonlySet<string> = new Set(['pwd', 'passcode'])
const TEAMS_PARAM = 'p'

function isTeamsHost(hostname: string): boolean {
  return (
    hostname === 'teams.microsoft.com' || hostname.endsWith('.teams.microsoft.com') || hostname === 'teams.live.com'
  )
}

/** The parameter name of one `name=value` pair, decoded the way a browser does (so `pwd%3DX` and `%70wd=X` are `pwd`). */
function pairName(pair: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(pair.replace(/\+/g, ' '))
  } catch {
    // A bad escape: URLSearchParams reads what it can and keeps the rest literally.
    decoded = new URLSearchParams(pair).keys().next().value ?? ''
  }
  return (decoded.split('=')[0] ?? '').trim().toLowerCase()
}

/** `a=1&pwd=X;b=2` without the pairs named in `names`; the separators of the pairs that stay are kept as written. */
function dropPairs(query: string, names: ReadonlySet<string>): string {
  const parts = query.split(/([&;])/)
  let out = ''
  for (let i = 0; i < parts.length; i += 2) {
    const pair = parts[i] as string
    if (pair !== '' && names.has(pairName(pair))) continue
    // The separator in front of a kept pair stays, except at the start of the result.
    out += (out === '' ? '' : (parts[i - 1] ?? '&')) + pair
  }
  return out
}

/**
 * Removes meeting passcodes from a link. Returns '' when `url` is not a URL. Parameter names match in any case, also
 * written with a percent escape (`pwd%3D`, `%70wd`); pairs split on `&` and `;`. The fragment is cut the same way
 * (`#success?pwd=X`, `#pwd=X`). Only the matching `name=value` pairs are removed from the raw text, so the rest
 * keeps its original encoding.
 */
export function stripPasscode(input: string): string {
  // Same clean-up as the WHATWG URL parser, so `pw<TAB>d` is seen as `pwd` here as it is by a browser.
  const url = input.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '')
  if (!URL.canParse(url)) return ''
  const names = new Set(ANY_HOST_PARAMS)
  if (isTeamsHost(new URL(url).hostname)) names.add(TEAMS_PARAM)

  const hashAt = url.indexOf('#')
  const beforeFragment = hashAt === -1 ? url : url.slice(0, hashAt)
  let fragment = ''
  if (hashAt !== -1) {
    const raw = url.slice(hashAt + 1)
    const queryAt = raw.indexOf('?')
    const kept =
      queryAt === -1
        ? dropPairs(raw, names)
        : `${raw.slice(0, queryAt)}${withQuery(dropPairs(raw.slice(queryAt + 1), names))}`
    fragment = kept === '' ? '' : `#${kept}`
  }
  const queryAt = beforeFragment.indexOf('?')
  if (queryAt === -1) return beforeFragment + fragment
  const kept = dropPairs(beforeFragment.slice(queryAt + 1), names)
  return beforeFragment.slice(0, queryAt) + withQuery(kept) + fragment
}

const withQuery = (query: string): string => (query === '' ? '' : `?${query}`)
