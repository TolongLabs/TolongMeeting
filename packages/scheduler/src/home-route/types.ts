import type { JobConfig } from '@tm/core'
import type { TailscaleApi } from '@tm/web/lib/home-route'
import type { LaunchDeps } from '../launch'

/**
 * The home exit node (or the tunnel to it) can't carry the worker right now: the sidecar's tunnel did not come up in
 * time, or the node is gone. `launchViaHome` throws it; the check counts it as an offline home device and tries again.
 */
export class HomeRouteUnavailable extends Error {
  constructor(message = 'The home exit node is not reachable.') {
    super(message)
    this.name = 'HomeRouteUnavailable'
  }
}

/** What the home route check uses: the launcher's own dependencies, a Tailscale client and the way to launch. */
export interface HomeDeps extends Pick<LaunchDeps, 'db' | 'queue' | 'notifier' | 'master' | 'env'> {
  api: TailscaleApi
  /** Starts the member's sidecar through the exit node at `exitNodeIp` and the worker behind it (plan 08 T13). */
  launchViaHome(cfg: JobConfig, exitNodeIp: string): Promise<void>
}
