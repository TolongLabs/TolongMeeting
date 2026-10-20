import type { LaunchDeps } from './launch'

/**
 * STUB (plan 03 T6 replaces this file; `main.ts` is not edited again). The `native-job-check` handler: sent at +120 s
 * after a native transcription job is created, it moves a recording that no PC has claimed to `waiting_for_pc`. Returns
 * the outcome for the log (`done`, `failed`, `claimed` or `waiting_for_pc`).
 *
 * Nothing sends to `native-job-check` until T6 lands, and the queue has no schedule. A job that arrives anyway fails
 * loudly here and is retried, then dead-lettered, instead of being taken for a success.
 */
export async function handleNativeJobCheck(_deps: LaunchDeps, _data: unknown, _now: Date): Promise<string> {
  throw new Error('native-job-check: not implemented yet (plan 03 T6)')
}

/** STUB (plan 03 T6). The `native-job-dead` handler: a check whose retries are spent must not strand the recording. */
export async function handleNativeJobDead(_deps: LaunchDeps, _data: unknown, _now: Date): Promise<string> {
  throw new Error('native-job-dead: not implemented yet (plan 03 T6)')
}
