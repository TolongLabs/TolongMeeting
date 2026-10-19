const ANY_HOST_PARAMS = ['pwd', 'passcode'] as const
const TEAMS_PARAM = 'p'

function isTeamsHost(hostname: string): boolean {
  return (
    hostname === 'teams.microsoft.com' || hostname.endsWith('.teams.microsoft.com') || hostname === 'teams.live.com'
  )
}

/** Removes meeting passcodes from a link. Returns '' when `url` is not a URL. */
export function stripPasscode(url: string): string {
  if (!URL.canParse(url)) return ''
  const parsed = new URL(url)
  const params = parsed.searchParams
  let removed = false
  for (const name of ANY_HOST_PARAMS) {
    if (params.has(name)) {
      params.delete(name)
      removed = true
    }
  }
  if (isTeamsHost(parsed.hostname) && params.has(TEAMS_PARAM)) {
    params.delete(TEAMS_PARAM)
    removed = true
  }
  return removed ? parsed.toString() : url
}
