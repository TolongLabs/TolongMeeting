import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Writes a file whole or not at all: a temporary name in the same directory, then a rename. */
export async function writeFileAtomic(file: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, content, { mode, flag: 'wx' })
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

/** Serialises async tasks so two read-modify-write cycles on one file never interleave. */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task)
    this.tail = next.catch(() => undefined)
    return next
  }
}

export function isMissing(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT'
}
