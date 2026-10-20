import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const FILE = 'joined-link'

/**
 * The meeting link a watcher found, kept so a restarted attempt rejoins the same meeting. It may hold a passcode: the
 * file is private to the worker (mode 0600), is no artefact row so it is never served, and goes with the data dir.
 * The link never goes into an event, a log or a ping.
 */
export async function writeJoinedLink(dataDir: string, url: string): Promise<void> {
  const path = join(dataDir, FILE)
  const temp = `${path}.tmp-${randomUUID()}`
  try {
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(url)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  const dir = await open(dirname(path), 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

/** The kept link; null when no attempt kept one. */
export async function readJoinedLink(dataDir: string): Promise<string | null> {
  try {
    const url = (await readFile(join(dataDir, FILE), 'utf8')).trim()
    return url === '' ? null : url
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
