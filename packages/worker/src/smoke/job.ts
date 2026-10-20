import type { JobConfig, Platform } from '@tm/core'
import { alertPing } from '@tm/notify'
import { setupProfile } from '../profile-setup'
import { defaultDeps, type RunDeps } from '../run-deps'
import { SMOKE_ENTRIES } from './entries'
import { runSmokeEntry } from './run'

/**
 * The monthly smoke test for one job: restores or prepares the identity's profile, joins the platform's standing test
 * meeting (the job's fixed link) on the stage, and reports what is missing. Anything missing sends one alert to the
 * job's ntfy topic. The profile is checkpointed after the browser closes, as `seedProfile` does, so a token the
 * platform refreshed is kept. A stop signal ends the test with an error.
 */
export async function smokeJob(
  cfg: JobConfig,
  overrides: Partial<RunDeps> = {}
): Promise<{ platform: Platform; missing: string[] }> {
  const deps = { ...defaultDeps, ...overrides }
  const link = cfg.entry.link
  if (link.kind !== 'fixed') throw new Error('a smoke job needs a fixed link (the standing test meeting)')
  const platform = deps.adapterFor(link.url)?.platform
  if (platform === undefined) throw new Error('the smoke job link is not a supported meeting link')
  const entry = SMOKE_ENTRIES.find((e) => e.platform === platform)
  if (entry === undefined) throw new Error(`there is no smoke entry for ${platform}`)

  const profile = await setupProfile(cfg, deps)
  const screen = await deps.startScreen()
  let missing: string[]
  try {
    const browser = await deps.launchBrowser(cfg.profileDir, screen)
    try {
      const stopped = new Promise<never>((_, reject) =>
        deps.signal?.addEventListener('abort', () => reject(new Error('the smoke test was stopped')), { once: true })
      )
      ;({ missing } = await Promise.race([runSmokeEntry(browser.stage, entry, link.url), stopped]))
    } finally {
      // The profile is copied only once the browser has closed: an open profile could be copied half-written.
      await browser.context.close()
      await deps.checkpointProfile(cfg.profileDir, profile.checkpointsDir, profile.key)
    }
  } finally {
    await screen.stop()
  }
  if (missing.length > 0) {
    await deps.sendPing(cfg.ntfy, alertPing(`Smoke test: ${platform}`, 'join_failed', `missing ${missing.join(', ')}`))
  }
  return { platform, missing }
}
