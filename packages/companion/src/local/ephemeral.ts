import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Files a container needs only at start (the job and the profile key), kept on the PC just long enough for it to read
// them. The folder is owner-only; `remove` overwrites each file with zeros before it deletes the folder.

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DEFAULT_MAX_MS = 120_000

export interface Ephemeral {
  dir: string
  remove(): Promise<void>
}

/** Makes `<dir>/<random>/` and writes `files` into it (names, not paths). A failed write removes what was written. */
export async function writeEphemeral(dir: string, files: Record<string, string | Buffer>): Promise<Ephemeral> {
  for (const name of Object.keys(files)) {
    if (!FILE_NAME.test(name)) throw new Error('a short-lived file needs a plain file name')
  }
  const own = join(dir, randomBytes(12).toString('hex'))
  await mkdir(own, { recursive: true, mode: 0o700 })
  const remove = async (): Promise<void> => {
    let names: string[] = []
    try {
      names = await readdir(own)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const name of names) {
      const file = join(own, name)
      await writeFile(file, Buffer.alloc((await stat(file)).size))
    }
    await rm(own, { recursive: true, force: true })
  }
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(join(own, name), content, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(own, { recursive: true, force: true })
    throw error
  }
  return { dir: own, remove }
}

/**
 * Removes the files once the worker's first heartbeat arrived, or after `maxMs` (default 120 s), whichever is first.
 * The files go in both cases; a heartbeat that fails is rethrown after the removal.
 */
export async function removeAfterFirstHeartbeat(
  e: Pick<Ephemeral, 'remove'>,
  firstHeartbeat: Promise<void>,
  maxMs = DEFAULT_MAX_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([firstHeartbeat, new Promise<void>((resolve) => (timer = setTimeout(resolve, maxMs)))])
  } finally {
    clearTimeout(timer)
    await e.remove()
  }
}
