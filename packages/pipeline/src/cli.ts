import { AiKeyError } from '@tm/ai'
import { JobError, parseJob } from '@tm/core'
import { runPipeline } from './pipeline'

const USAGE = 'usage: tm-pipeline --job <path>'

// Exit codes: 0 done, 1 any other error, 2 the AI key was rejected, 64 usage, 65 invalid job.
// Only issue paths are printed for a bad job, never values, so a key or token cannot leak.
export async function main(argv: string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--job' || argv[1] === undefined || argv[1].startsWith('--')) {
    console.error(USAGE)
    return 64
  }
  const jobPath = argv[1]
  let json: unknown
  try {
    json = JSON.parse(await Bun.file(jobPath).text())
  } catch {
    console.error('tm-pipeline: the job file is missing or is not valid JSON')
    return 65
  }
  let cfg
  try {
    cfg = parseJob(json)
  } catch (e) {
    if (!(e instanceof JobError)) throw e
    console.error(`tm-pipeline: invalid job: ${e.paths.join(', ')}`)
    return 65
  }
  try {
    await runPipeline(cfg)
    return 0
  } catch (e) {
    if (e instanceof AiKeyError) {
      console.error(`tm-pipeline: the AI key was rejected (${e.status}). Fix the key and run again.`)
      return 2
    }
    console.error(`tm-pipeline: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
