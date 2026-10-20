import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ping } from '@tm/notify'
import { loadBundle } from './bundle'
import type { ExportRow, RunnerStore } from './store-types'
import {
  ExportError,
  TARGET_CONNECTION,
  TARGET_LABEL,
  type Connection,
  type ConnectionKind,
  type ExportErrorCode,
  type ExportResult,
  type ExportTarget,
  type ExportTargetId,
  type OccurrenceLookup
} from './types'
import { redact } from './vault'

// The queue is the `exports` table: a row is `queued` until `claimNext` makes it `running` (`for update skip locked`,
// so two runners never take one row), and ends `succeeded` or `failed`. The policy pg-boss queues state explicitly is
// stated here the same way:
//   expire         EXPORT_TIMEOUT_MS: an export that runs longer fails with 'failed' and its calls are aborted.
//   retry          none. An export has side effects in the member's own services; the member presses the button again.
//   dead letter    `failInterrupted` at start-up fails every row still `running` (the process died) and pings.
//   retention      `purgeDeleted` every PURGE_EVERY_MS removes the rows of deleted meetings; the files go with the
//                  meeting's directory (retention's `deleteOccurrenceData`).

/** The longest an export may run before it is failed and its network calls are aborted. */
export const EXPORT_TIMEOUT_MS = 10 * 60_000
/** The largest file an export may leave in the occurrence directory (the bundle itself is capped at 256 MB). */
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024
/** How often the rows of deleted meetings are purged. */
export const PURGE_EVERY_MS = 3_600_000
/** How often `beat` runs while an export is working, so a health check sees a live process during a long export. */
export const HEARTBEAT_MS = 5_000
/** The most characters of an unexpected error's message that a member sees. */
const MAX_UNEXPECTED_MESSAGE = 300

/** What the runner needs of a member's connections. The tokens stay inside this process. */
export interface RunnerConnections {
  get(
    memberId: string,
    kind: ConnectionKind
  ): Promise<{ connection: Connection; status: 'ok' | 'reconnect_needed' } | null>
  save(memberId: string, c: Connection): Promise<void>
  markReconnect(memberId: string, kind: ConnectionKind): Promise<void>
}

export interface RunnerDeps {
  store: RunnerStore
  connections: RunnerConnections
  occurrences: OccurrenceLookup
  targets: Partial<Record<ExportTargetId, ExportTarget>>
  /** Resolves false when the ping did not go out; the notifier never throws. */
  ping(memberId: string, p: Ping): Promise<boolean>
  publicUrl: string
  http: typeof fetch
  sleep(ms: number): Promise<void>
  /** One line, never a secret, a token or text from a meeting. */
  log(line: string): void
  /** Touches the health file. */
  beat?(): void
  timeoutMs?: number
  maxOutputBytes?: number
}

type Outcome = { ok: true; result: ExportResult } | { ok: false; code: ExportErrorCode; message: string }

const RECONNECT_CODES: ReadonlySet<ExportErrorCode> = new Set([
  'not_connected',
  'reconnect_needed',
  'invalid_settings',
  'not_found'
])

/** The notification for an export that ended. `title` is the meeting's title when it is known. */
export function exportPing(row: ExportRow, title: string | null, outcome: Outcome, publicUrl: string): Ping {
  const meetingPage = { label: 'Open meeting page', url: `${publicUrl}/meetings/${row.occurrenceId}` }
  const label = TARGET_LABEL[row.target]
  const name = title ?? row.title ?? 'This meeting'
  if (outcome.ok) {
    if (TARGET_CONNECTION[row.target] === null) {
      return {
        title: 'Export finished',
        message: `"${name}" is ready to download.`,
        priority: 'default',
        actions: [meetingPage]
      }
    }
    const { url, note } = outcome.result
    return {
      title: 'Export finished',
      message: note ? `"${name}" was already up to date in ${label}.` : `"${name}" is in ${label}.`,
      priority: 'default',
      actions: url ? [{ label: 'Open', url }, meetingPage] : [meetingPage]
    }
  }
  const reconnect = TARGET_CONNECTION[row.target] !== null && RECONNECT_CODES.has(outcome.code)
  return {
    title: 'Export failed',
    message: `"${name}" to ${label}: ${outcome.message}`,
    priority: 'default',
    actions: reconnect ? [{ label: 'Reconnect', url: `${publicUrl}/connections` }, meetingPage] : [meetingPage]
  }
}

/** The name of an error and its `code`, never its message: a message can quote a token or a path. */
function errorBrief(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  const name = e instanceof Error ? e.name : 'unknown'
  return typeof code === 'string' ? `${name} ${code}` : name
}

/** Every secret a connection holds, to be removed from any text that is stored or shown. */
function tokensOf(c: Connection): string[] {
  if (c.kind === 'github') return [c.token]
  if (c.kind === 'google') return [c.refreshToken]
  return c.refreshToken === null ? [c.accessToken] : [c.accessToken, c.refreshToken]
}

/** Removes what an export that did not finish may have left in `<dataDir>/exports`. Never follows a planted symlink. */
async function removeOutputs(outDir: string, exportId: string): Promise<void> {
  const dir = await lstat(outDir).catch(() => null)
  if (dir === null || !dir.isDirectory()) return
  await Promise.all(['zip', 'pdf'].map((ext) => rm(join(outDir, `${exportId}.${ext}`), { force: true })))
}

/** A download must be the one regular file this export names, and no larger than `max`. */
async function checkOutput(dataDir: string, id: string, result: ExportResult, max: number): Promise<void> {
  if (result.filePath === null) return
  if (result.filePath !== `exports/${id}.zip` && result.filePath !== `exports/${id}.pdf`)
    throw new ExportError('failed', 'The export file is in the wrong place.')
  const info = await lstat(join(dataDir, result.filePath))
  if (!info.isFile()) throw new ExportError('failed', 'The export file is not a regular file.')
  if (info.size > max) {
    throw new ExportError('failed', `The export file is larger than ${Math.floor(max / (1024 * 1024))} MB.`)
  }
}

/** Runs `work` for at most `ms`. At the deadline its signal aborts and the call fails; a late result is dropped. */
async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new ExportError('failed', 'The export took too long. Try again.'))
    }, ms)
  })
  const running = work(ac.signal)
  // After the deadline the work may still fail; nobody is waiting for that.
  running.catch(() => undefined)
  try {
    return await Promise.race([running, deadline])
  } finally {
    clearTimeout(timer)
  }
}

interface Progress {
  title: string | null
}

async function execute(row: ExportRow, deps: RunnerDeps, secrets: string[], progress: Progress): Promise<ExportResult> {
  const occurrence = await deps.occurrences.get(row.memberId, row.occurrenceId)
  if (!occurrence || occurrence.state === 'deleted') {
    throw new ExportError('meeting_deleted', 'This meeting has been deleted from TolongMeeting.')
  }
  if (occurrence.state !== 'completed') {
    throw new ExportError('not_ready', 'This meeting is still being processed.')
  }
  const target = deps.targets[row.target]
  if (!target) throw new ExportError('failed', "This export isn't available yet.")

  const kind = TARGET_CONNECTION[row.target]
  const label = TARGET_LABEL[row.target]
  let connection: Connection | null = null
  if (kind !== null) {
    const found = await deps.connections.get(row.memberId, kind)
    if (!found) throw new ExportError('not_connected', `Connect ${label} on the Connections page first.`)
    secrets.push(...tokensOf(found.connection))
    if (found.status === 'reconnect_needed') {
      throw new ExportError('not_connected', `${label} needs you to connect again on the Connections page.`)
    }
    connection = found.connection
  }

  const outDir = join(occurrence.dataDir, 'exports')
  try {
    const result = await withTimeout(deps.timeoutMs ?? EXPORT_TIMEOUT_MS, async (signal) => {
      const bundle = await loadBundle(occurrence.dataDir)
      progress.title = bundle.title
      const stopped = () => new ExportError('failed', 'The export took too long. Try again.')
      return target.run(bundle, {
        exportId: row.id,
        memberId: row.memberId,
        outDir,
        connection,
        saveConnection: async (c) => {
          // A rotated token is a secret from now on too.
          secrets.push(...tokensOf(c))
          await deps.connections.save(row.memberId, c)
        },
        http: ((input, init) =>
          deps.http(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal
          })) as typeof fetch,
        sleep: (ms) => {
          if (signal.aborted) return Promise.reject(stopped())
          return Promise.race([
            deps.sleep(ms),
            new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(stopped()), { once: true }))
          ])
        }
      })
    })
    await checkOutput(occurrence.dataDir, row.id, result, deps.maxOutputBytes ?? MAX_OUTPUT_BYTES)
    return result
  } catch (e) {
    await removeOutputs(outDir, row.id)
    throw e
  }
}

async function announce(row: ExportRow, title: string | null, outcome: Outcome, deps: RunnerDeps): Promise<void> {
  try {
    if (!(await deps.ping(row.memberId, exportPing(row, title, outcome, deps.publicUrl)))) {
      deps.log(`export ${row.id} ${row.target} ping not sent`)
    }
  } catch (e) {
    deps.log(`export ${row.id} ${row.target} ping failed (${errorBrief(e)})`)
  }
}

/**
 * Runs one claimed (running) export to its end: it ends `succeeded` or `failed`, never anything else, and the member is
 * pinged. A message is stored only after `redact` has removed the connection's tokens; an error that is not an
 * `ExportError` becomes a fixed sentence around its redacted message, and only its name and code are logged.
 */
export async function runExport(row: ExportRow, deps: RunnerDeps): Promise<void> {
  const secrets: string[] = []
  const progress: Progress = { title: null }
  let outcome: Outcome
  let detail = ''
  try {
    outcome = { ok: true, result: await execute(row, deps, secrets, progress) }
  } catch (e) {
    if (e instanceof ExportError) {
      outcome = { ok: false, code: e.code, message: redact(e.message, secrets) }
    } else {
      const message = redact(e instanceof Error ? e.message : 'unknown error', secrets).slice(0, MAX_UNEXPECTED_MESSAGE)
      outcome = { ok: false, code: 'failed', message: `Something went wrong: ${message}. Try again.` }
      detail = ` (${errorBrief(e)})`
    }
  }

  if (outcome.ok) {
    await deps.store.succeed(row.id, progress.title ?? 'Meeting', outcome.result)
    deps.log(`export ${row.id} ${row.target} succeeded`)
  } else {
    const kind = TARGET_CONNECTION[row.target]
    if (outcome.code === 'reconnect_needed' && kind !== null) await deps.connections.markReconnect(row.memberId, kind)
    await deps.store.fail(row.id, outcome.code, outcome.message, secrets)
    deps.log(`export ${row.id} ${row.target} failed ${outcome.code}${detail}`)
  }
  await announce(row, progress.title, outcome, deps)
}

/** Waits `ms`, or less when `signal` aborts. */
async function pause(deps: RunnerDeps, ms: number, signal: AbortSignal): Promise<void> {
  let wake: () => void = () => undefined
  const aborted = new Promise<void>((resolve) => {
    wake = resolve
    signal.addEventListener('abort', wake, { once: true })
  })
  await Promise.race([deps.sleep(ms), aborted])
  signal.removeEventListener('abort', wake)
}

/**
 * Fails the exports an earlier process left running (and pings them), then runs queued exports one at a time, oldest
 * first, until `signal` aborts. An export in progress finishes first. `purgeDeleted` runs at the start and every
 * `PURGE_EVERY_MS`. An error in one pass is logged by name and code and the loop goes on after `pollMs`.
 */
export async function runLoop(deps: RunnerDeps, signal: AbortSignal, pollMs = 2000): Promise<void> {
  for (const row of await deps.store.failInterrupted()) {
    deps.log(`export ${row.id} ${row.target} failed interrupted`)
    await announce(
      row,
      null,
      { ok: false, code: 'interrupted', message: row.error ?? 'The export was interrupted. Try again.' },
      deps
    )
  }
  let lastPurge = Number.NEGATIVE_INFINITY
  while (!signal.aborted) {
    try {
      if (Date.now() - lastPurge >= PURGE_EVERY_MS) {
        const purged = await deps.store.purgeDeleted()
        lastPurge = Date.now()
        if (purged > 0) deps.log(`exports purged: ${purged}`)
      }
      const row = await deps.store.claimNext()
      if (row !== null) {
        const beat = setInterval(() => deps.beat?.(), HEARTBEAT_MS)
        try {
          await runExport(row, deps)
        } catch (e) {
          // Whatever stopped it (the database, a purged row), the row must not stay running: that would block the next
          // export of this meeting and target until a restart.
          deps.log(`export ${row.id} ${row.target} stopped (${errorBrief(e)})`)
          await deps.store.fail(row.id, 'failed', 'The export did not finish. Try again.').catch((f: unknown) => {
            deps.log(`export ${row.id} ${row.target} could not be failed (${errorBrief(f)})`)
          })
        } finally {
          clearInterval(beat)
        }
        continue
      }
    } catch (e) {
      deps.log(`export loop error (${errorBrief(e)})`)
    }
    deps.beat?.()
    await pause(deps, pollMs, signal)
  }
}
