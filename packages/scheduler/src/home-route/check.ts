import type { JobConfig } from '@tm/core'
import type { LaunchDeps } from '../launch'

/**
 * STUB (plan 08 T12 replaces this file; `main.ts` is not edited again). Plan 08 T2's hook in `launch.ts` calls this for
 * a `server_via_home` occurrence, outside the launch lock: it checks the member's home exit node and launches the worker
 * through it (`launched`), asks for another look in 60 s (`waiting`) or fails the occurrence (`failed`). T12 builds its
 * own `HomeDeps` (Tailscale client, `launchViaHome`) from `deps` and `process.env`, and keeps this signature.
 *
 * Nothing calls it, and nothing sends to the home-route queues, until T2 and T12 land. If it is called anyway it fails
 * loudly instead of reporting a launch.
 */
export async function startViaHome(
  _deps: LaunchDeps,
  _cfg: JobConfig,
  _now: Date
): Promise<'launched' | 'waiting' | 'failed'> {
  throw new Error('startViaHome: not implemented yet (plan 08 T12)')
}

/** STUB (plan 08 T12). The `home-route-recheck` handler: rebuilds the `JobConfig` and calls `startViaHome` again. */
export async function handleHomeRouteRecheck(_deps: LaunchDeps, _data: unknown, _now: Date): Promise<string> {
  throw new Error('home-route-recheck: not implemented yet (plan 08 T12)')
}

/** STUB (plan 08 T12). The `home-route-dead` handler: a recheck whose retries are spent must not strand the occurrence. */
export async function handleHomeRouteDead(_deps: LaunchDeps, _data: unknown, _now: Date): Promise<string> {
  throw new Error('home-route-dead: not implemented yet (plan 08 T12)')
}
