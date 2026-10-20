import { oauthClientFromEnv } from './connections/oauth'
import { createGdocsTarget } from './targets/gdocs'
import { githubTarget } from './targets/github'
import { createNotionTarget } from './targets/notion'
import { pdfTarget } from './targets/pdf'
import { zipTarget } from './targets/zip'
import type { ExportTarget, ExportTargetId, OAuthClient } from './types'

// The web routes import this from `./connections/oauth` (through the `api` entry), which has no renderers.
export { oauthClientFromEnv }

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
  return {
    zip: zipTarget,
    pdf: pdfTarget,
    github: githubTarget,
    ...(clients.google ? { gdocs: createGdocsTarget(clients.google) } : {}),
    ...(clients.notion ? { notion: createNotionTarget(clients.notion) } : {})
  }
}
