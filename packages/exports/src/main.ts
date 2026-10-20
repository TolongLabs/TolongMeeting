import { writeFileSync } from 'node:fs'
import { memberNotifier } from '@tm/web/db/notifier'
import { closeDb, getDb } from '@tm/web/db'
import { memberConnections, memberOccurrences } from '@tm/web/db/exports'
import { loadMasterKey } from '@tm/web/db/secrets'
import { createScope } from '@tm/web/lib/scope'
import { readExportsEnv, EnvError } from './env'
import { buildTargets, oauthClientFromEnv } from './registry'
import { runLoop, type RunnerDeps } from './runner'
import { runnerStore } from './store'

/** Touched every few seconds while the process works; the Compose health check fails when it is older than a minute. */
export const HEALTH_FILE = '/tmp/tm-exports-alive'
/** How long a shutdown waits for the export in progress. */
const DRAIN_MS = 30_000
/** The hard stop, below Compose's grace period (60 s): the process exits instead of waiting for SIGKILL. */
export const SHUTDOWN_DEADLINE_MS = 45_000

/** The name of an error and its `code`, never its message: a query error can quote values, a fetch error a URL. */
const errorBrief = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code
  const name = e instanceof Error ? e.name : 'unknown'
  return typeof code === 'string' ? `${name} ${code}` : name
}

async function main(): Promise<void> {
  // 1. The environment. A bad variable stops the process before anything is opened.
  const env = readExportsEnv(process.env)
  const master = loadMasterKey(env.masterKeyFile)
  const db = getDb()
  const notifier = memberNotifier(db, master, env.ntfyUrl)

  // Member-facing stores are bound to one member by a scope; the runner serves every member, so it makes one per call.
  const deps: RunnerDeps = {
    store: runnerStore(db),
    connections: {
      get: (memberId, kind) => memberConnections(createScope(db, memberId), master).get(kind),
      save: (memberId, c) => memberConnections(createScope(db, memberId), master).save(c),
      markReconnect: (memberId, kind) => memberConnections(createScope(db, memberId), master).markReconnect(kind)
    },
    occurrences: {
      get: (memberId, occurrenceId) => memberOccurrences(createScope(db, memberId), env.dataRoot).get(occurrenceId)
    },
    targets: buildTargets({ google: oauthClientFromEnv('google'), notion: oauthClientFromEnv('notion') }),
    ping: (memberId, p) => notifier.notify(memberId, p),
    publicUrl: env.publicUrl,
    http: fetch,
    sleep: (ms) => Bun.sleep(ms),
    log: (line) => console.log(line),
    beat: () => writeFileSync(HEALTH_FILE, new Date().toISOString())
  }

  const stop = new AbortController()
  writeFileSync(HEALTH_FILE, new Date().toISOString())
  const loop = runLoop(deps, stop.signal)
  console.log(`exports running (${Object.keys(deps.targets).join(', ')})`)

  // SIGTERM drains: no new export is claimed, the one in progress finishes (bounded), then the pool closes. A row left
  // running is failed as interrupted by the next start.
  let stopping = false
  const drain = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    // If the steps below hang, this ends the process before Compose's SIGKILL. It never keeps a finished process alive.
    setTimeout(() => {
      console.error(`shutdown: not finished within ${SHUTDOWN_DEADLINE_MS / 1000} s; exiting`)
      process.exit(1)
    }, SHUTDOWN_DEADLINE_MS).unref()
    stop.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), DRAIN_MS)))
    if ((await Promise.race([loop.then(() => 'done' as const), late])) === 'late') {
      console.error(`shutdown: the export in progress did not finish within ${DRAIN_MS / 1000} s`)
    }
    clearTimeout(timer)
    await closeDb()
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      drain().then(
        () => process.exit(0),
        (e) => {
          console.error(`shutdown failed (${errorBrief(e)})`)
          process.exit(1)
        }
      )
    })
  }
  await loop
}

if (import.meta.main) {
  main().catch((e) => {
    // A start-up refusal names variables only. Any other error is logged by name and code, never its message.
    console.error(e instanceof EnvError ? e.message : `exports stopped: ${errorBrief(e)}`)
    process.exit(1)
  })
}
