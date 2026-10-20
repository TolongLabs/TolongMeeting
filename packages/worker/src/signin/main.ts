import { readFile } from 'node:fs/promises'
import type { AccountCheckData, SigninJob } from '@tm/core'
import { SigninJobSchema, controlTokenHash, vncSecret } from '@tm/core'
import type { Page } from 'playwright'
import { launchBrowser, openDeskTab } from '../chrome/launch'
import { openSigninTabs, restoreDeskAnchor } from '../control/desk-tabs'
import { realClock } from '../control/desk-pause'
import { idleMs, startVnc } from '../control/vnc'
import { startScreen } from '../display/screen'
import { loadProfileKey } from '../profile/key'
import { checkpointProfile, prepareProfile, restoreProfile } from '../profile/profile'
import { setupProfile, type ProfileSetup } from '../profile-setup'
import type { Screen } from '../types'
import { checkSigninAccounts } from './accounts'
import { signinPoster } from './post'
import { runSignin, type SigninDeps } from './run-signin'

const USAGE = 'usage: signin <job file>'

// Exit codes: 0 the session ended (done, idle or stopped by SIGTERM), 1 it failed, 64 usage, 65 invalid job.
const EXIT = { ended: 0, failed: 1, usage: 64, invalid: 65 } as const

// Reads and validates the job. A message names the failing paths only: the file holds a token.
async function loadJob(file: string): Promise<SigninJob | null> {
  let json: unknown
  try {
    json = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    console.error('invalid job: the file cannot be read or is not JSON')
    return null
  }
  const parsed = SigninJobSchema.safeParse(json)
  if (!parsed.success) {
    console.error(`invalid job: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
    return null
  }
  return parsed.data
}

/** The real collaborators of `runSignin`: the screen, the browser, the profile and the remote view of one container. */
export function signinDeps(job: SigninJob, signal?: AbortSignal): SigninDeps {
  const secret = vncSecret(controlTokenHash(job.control.token))
  let screen: Screen | null = null
  let profile: ProfileSetup | null = null
  const started = (): { screen: Screen; profile: ProfileSetup } => {
    if (screen === null || profile === null) throw new Error('the desk is not open')
    return { screen, profile }
  }
  return {
    async openDesk() {
      const ready = await setupProfile(
        { identity: { id: job.identityId }, profileDir: job.profileDir },
        { loadProfileKey, prepareProfile, restoreProfile }
      )
      if (ready.checkpointsDir !== job.checkpointsDir) {
        throw new Error('the job names a checkpoint directory other than TM_PROFILE_ROOT/<identity>/checkpoints')
      }
      const display = await startScreen()
      let browser: Awaited<ReturnType<typeof launchBrowser>>
      try {
        browser = await launchBrowser(job.profileDir, display)
      } catch (error) {
        await display.stop()
        throw error
      }
      screen = display
      profile = ready
      let deskPage = browser.desk
      let closeListeners: (() => void | Promise<void>)[] = []

      const hookClose = (page: Page) => {
        page.once('close', async () => {
          if (deskPage !== page) return
          for (const cb of [...closeListeners]) await cb()
        })
      }
      hookClose(deskPage)

      return {
        // The tabs close with the browser.
        openTabs: async (urls) => {
          await openSigninTabs(deskPage, urls, (e) =>
            console.error(`signin: a start page did not load: ${e instanceof Error ? e.message : String(e)}`)
          )
        },
        reopenDesk: async () => {
          deskPage = await openDeskTab(browser.context)
          hookClose(deskPage)
        },
        onDeskClose: (cb) => {
          closeListeners.push(cb)
          return {
            stop: async () => {
              closeListeners = closeListeners.filter((l) => l !== cb)
            }
          }
        },
        checkAccounts: async (): Promise<AccountCheckData[]> => {
          // The member may have closed the anchor tab.
          const desk = await restoreDeskAnchor(deskPage)
          return checkSigninAccounts(desk, browser.context.pages())
        },
        close: async () => {
          try {
            await browser.context.close()
          } finally {
            await display.stop()
          }
        }
      }
    },
    startVnc: () => startVnc(started().screen.display, started().screen.desk, secret),
    idleMs: () => idleMs(started().screen.display),
    checkpoint: () => {
      const { profile: ready } = started()
      return checkpointProfile(job.profileDir, job.checkpointsDir, ready.key).then(() => undefined)
    },
    post: signinPoster(job.control),
    clock: realClock,
    ...(signal ? { signal } : {})
  }
}

async function main(): Promise<number> {
  const file = process.argv[2]
  if (file === undefined || process.argv.length > 3) {
    console.error(USAGE)
    return EXIT.usage
  }
  const job = await loadJob(file)
  if (job === null) return EXIT.invalid
  // docker stop sends SIGTERM: the session ends as `done` and finishes inside the stop timeout.
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  await runSignin(job, signinDeps(job, abort.signal))
  return EXIT.ended
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`signin failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(EXIT.failed)
  }
)
