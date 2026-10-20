import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The absolute path of the fixture occurrence directory (shapes of real 01a pipeline output). */
export const fixture = join(import.meta.dir, 'fixtures', 'occurrence')

const copies: string[] = []

/** A copy of the fixture in a fresh temporary directory; `removeCopies` deletes them. */
export async function copyFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-exports-'))
  copies.push(dir)
  await cp(fixture, dir, { recursive: true })
  return dir
}

export async function removeCopies(): Promise<void> {
  await Promise.all(copies.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}
