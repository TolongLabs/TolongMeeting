const ANY_HOST_PARAMS: ReadonlySet<string> = new Set(['pwd', 'passcode'])
const TEAMS_PARAM = 'p'

function isTeamsHost(hostname: string): boolean {
  return (
    hostname === 'teams.microsoft.com' || hostname.endsWith('.teams.microsoft.com') || hostname === 'teams.live.com'
  )
}

/**
 * Removes meeting passcodes from a link. Returns '' when `url` is not a URL. Parameter names match in any case. Only
 * the matching `name=value` pairs are cut from the raw query string, so the rest keeps its original encoding.
 */
export function stripPasscode(url: string): string {
  if (!URL.canParse(url)) return ''
  const names = new Set(ANY_HOST_PARAMS)
  if (isTeamsHost(new URL(url).hostname)) names.add(TEAMS_PARAM)

  const hashAt = url.indexOf('#')
  const fragment = hashAt === -1 ? '' : url.slice(hashAt)
  const beforeFragment = hashAt === -1 ? url : url.slice(0, hashAt)
  const queryAt = beforeFragment.indexOf('?')
  if (queryAt === -1) return url

  const kept = beforeFragment
    .slice(queryAt + 1)
    .split('&')
    .filter((pair) => {
      // URLSearchParams decodes the key (percent escapes and '+') without throwing on bad escapes.
      const key = new URLSearchParams(pair).keys().next().value
      return key === undefined || !names.has(key.toLowerCase())
    })
  const base = beforeFragment.slice(0, queryAt)
  return (kept.length > 0 ? `${base}?${kept.join('&')}` : base) + fragment
}
