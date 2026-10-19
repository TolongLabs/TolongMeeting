import { readFile } from 'node:fs/promises'
import { JobError, parseJob, type JobConfig } from '@tm/core'
import { runOccurrence } from './run'
import { seedProfile } from './seed'

const USAGE = 'usage: tm-worker [--seed] --job <path>'

// Exit codes: 0 completed, 1 any other outcome or a crash, 64 usage, 65 invalid job.
const EXIT = { completed: 0, other: 1, usage: 64, invalid: 65 } as const

function parseArgs(argv: string[]): { seed: boolean; job: string } | null {
  let seed = false
  let job: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seed') seed = true
    else if (arg === '--job' && job === null && argv[i + 1] !== undefined) job = argv[++i]!
    else return null
  }
  return job === null ? null : { seed, job }
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
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

  if (args.seed) {
    await seedProfile(cfg, { signal: abort.signal })
    return EXIT.completed
  }
  const outcome = await runOccurrence(cfg, { signal: abort.signal })
  console.error(`outcome: ${outcome.result}${outcome.reason ? ` (${outcome.reason})` : ''}`)
  return outcome.result === 'completed' ? EXIT.completed : EXIT.other
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`tm-worker failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(EXIT.other)
  }
)
