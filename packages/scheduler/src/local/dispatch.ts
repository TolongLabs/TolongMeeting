import type { LaunchDeps } from '../launch'

/**
 * STUB (plan 08 T2 replaces this file; `main.ts` is not edited again). The `local-claim-check` handler: at offer +120 s,
 * a local-run job that no PC has claimed is cancelled and the occurrence is skipped (`skip_pc_offline`). Returns the
 * outcome for the log (`claimed` or `skipped_pc_offline`).
 *
 * Nothing sends to the three local queues until T2 lands, and none has a schedule. A job that arrives anyway fails
 * loudly here and is retried; it changes nothing.
 */
export async function handleLocalClaimCheck(_deps: LaunchDeps, _data: unknown, _now: Date): Promise<string> {
  throw new Error('local-claim-check: not implemented yet (plan 08 T2)')
}

/** STUB (plan 08 T2). The `local-start-check` handler: at T-10, an occurrence still `starting` fails (`running` or `failed`). */
export async function handleLocalStartCheck(_deps: LaunchDeps, _data: unknown, _now: Date): Promise<string> {
  throw new Error('local-start-check: not implemented yet (plan 08 T2)')
}

/** STUB (plan 08 T2). The `local-start-dead` handler: a start check whose retries are spent must not strand the occurrence. */
export async function handleLocalStartDead(_deps: LaunchDeps, _data: unknown, _now: Date): Promise<string> {
  throw new Error('local-start-dead: not implemented yet (plan 08 T2)')
}
