import { readFile } from 'node:fs/promises'
import { JobError, parseJob, type JobConfig } from '@tm/core'
import { checkpointOnly } from './profile/checkpoint-only'
import { runOccurrence } from './run'
import { seedProfile } from './seed'
import { smokeJob } from './smoke/job'

const USAGE = 'usage: tm-worker [--seed | --smoke] --job <path> | tm-worker --checkpoint-only <identityId>'

// Exit codes: 0 completed (a smoke test with nothing missing), 1 any other outcome or a crash, 64 usage, 65 invalid job, 143 stopped by SIGTERM or SIGINT
// (128 + 15, the shell's code for a process ended by SIGTERM: a stop is not a normal end and not a failure).
const EXIT = { completed: 0, other: 1, usage: 64, invalid: 65, terminated: 143 } as const

function parseArgs(argv: string[]): { mode: 'run' | 'seed' | 'smoke'; job: string } | null {
  let mode: 'run' | 'seed' | 'smoke' = 'run'
  let job: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--seed' || arg === '--smoke') && mode === 'run') mode = arg === '--seed' ? 'seed' : 'smoke'
    else if (arg === '--job' && job === null && argv[i + 1] !== undefined) job = argv[++i]!
    else return null
  }
  return job === null ? null : { mode, job }
}

// Reads and validates the job. A message names the failing paths only: the file holds keys and tokens.
async function loadJob(file: string): Promise<JobConfig | null> {
  let json: unknown
  try {
    json = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    console.error('invalid job: the file cannot be read or is not JSON')
    return null
  }
  try {
    return parseJob(json)
  } catch (error) {
    if (!(error instanceof JobError)) throw error
    console.error(`invalid job: ${error.paths.join(', ')}`)
    return null
  }
}

// `--checkpoint-only <identityId>`: write one profile checkpoint and exit. It reads no job and starts nothing else.
async function checkpointMode(identityId: string): Promise<number> {
  const root = process.env.TM_PROFILE_ROOT
  if (!root) throw new Error('TM_PROFILE_ROOT is not set')
  const file = await checkpointOnly(identityId, { root })
  console.error(file === null ? 'checkpoint-only: no profile to checkpoint' : 'checkpoint-only: checkpoint written')
  return EXIT.completed
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--checkpoint-only') {
    if (argv.length === 2 && argv[1] !== undefined) return checkpointMode(argv[1])
    console.error(USAGE)
    return EXIT.usage
  }
  const args = parseArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return EXIT.usage
  }
  const cfg = await loadJob(args.job)
  if (cfg === null) return EXIT.invalid

  // docker stop sends SIGTERM: the run leaves the meeting and finishes its teardown within the stop timeout.
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)

  if (args.mode === 'seed') {
    await seedProfile(cfg, { signal: abort.signal })
    return EXIT.completed
  }
  if (args.mode === 'smoke') {
    // Only selector key names and step names are printed.
    const { platform, missing } = await smokeJob(cfg, { signal: abort.signal })
    console.error(missing.length === 0 ? `smoke: ${platform} ok` : `smoke: ${platform} missing ${missing.join(', ')}`)
    return missing.length === 0 ? EXIT.completed : EXIT.other
  }
  const outcome = await runOccurrence(cfg, { signal: abort.signal })
  console.error(`outcome: ${outcome.result}${outcome.reason ? ` (${outcome.reason})` : ''}`)
  if (outcome.endedBy === 'terminated') return EXIT.terminated
  return outcome.result === 'completed' ? EXIT.completed : EXIT.other
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`tm-worker failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(EXIT.other)
  }
)
