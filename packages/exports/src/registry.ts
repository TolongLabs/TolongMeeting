import { githubTarget } from './targets/github'
import { pdfTarget } from './targets/pdf'
import { zipTarget } from './targets/zip'
import type { ExportTarget, ExportTargetId, OAuthClient } from './types'

/**
 * The OAuth client of a provider from `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` or `NOTION_CLIENT_ID` /
 * `NOTION_CLIENT_SECRET`, or null when either is unset or empty (Compose passes an unset variable as ''). The redirect
 * address is `${TM_PUBLIC_URL}/api/connections/<kind>/callback`.
 */
export function oauthClientFromEnv(
  kind: 'google' | 'notion',
  env: Record<string, string | undefined> = process.env
): OAuthClient | null {
  const prefix = kind.toUpperCase()
  const clientId = env[`${prefix}_CLIENT_ID`]
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]
  if (!clientId || !clientSecret) return null
  const base = env.TM_PUBLIC_URL
  if (!base) throw new Error('TM_PUBLIC_URL is not set')
  return { clientId, clientSecret, redirectUri: `${base}/api/connections/${kind}/callback` }
}

/**
 * The targets this server can run. The downloads are always there. A remote target is added when its provider has an
 * OAuth client (or, for GitHub, always: the member's own token is all it needs); the remote targets are added to this
 * map by the tasks that write them, and a target missing from the map fails an export with "isn't available yet".
 */
export function buildTargets(clients: {
  google: OAuthClient | null
  notion: OAuthClient | null
}): Partial<Record<ExportTargetId, ExportTarget>> {
  void clients
  return { zip: zipTarget, pdf: pdfTarget, github: githubTarget }
}
