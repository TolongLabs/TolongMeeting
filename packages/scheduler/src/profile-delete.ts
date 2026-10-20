import type { LaunchDeps } from './launch'

/**
 * STUB (plan 08 T1 replaces this file; `main.ts` is not edited again). The `profile-delete` handler: removes an
 * identity's server-side profile (checkpoints, machine id, profile directory) after the member moves it to My PC. It
 * takes the profile lock first, so it throws (and is retried) while a sign-in container holds the profile.
 *
 * Nothing sends to `profile-delete` until T1 lands, and the queue has no schedule. A job that arrives anyway fails
 * loudly here and is retried; it deletes nothing.
 */
export async function handleProfileDelete(_deps: LaunchDeps, _data: unknown, _now: Date): Promise<string> {
  throw new Error('profile-delete: not implemented yet (plan 08 T1)')
}
