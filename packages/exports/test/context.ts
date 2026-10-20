import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connection, ExportContext } from '../src/types'

const occurrences: string[] = []

/**
 * An export context whose occurrence directory is a fresh temporary folder, with `outDir` inside it and not yet created.
 * `http` throws (no network in tests), `sleep` records its delay and resolves at once, and `saveConnection` records.
 */
export function testContext(
  over: Partial<ExportContext> = {}
): ExportContext & { sleeps: number[]; saved: Connection[] } {
  const occurrence = mkdtempSync(join(tmpdir(), 'tm-exports-occ-'))
  occurrences.push(occurrence)
  const sleeps: number[] = []
  const saved: Connection[] = []
  return {
    exportId: 'exp-test',
    memberId: 'member-test',
    outDir: join(occurrence, 'exports'),
    connection: null,
    saveConnection: async (c) => {
      saved.push(c)
    },
    http: (async () => {
      throw new Error('no network in tests')
    }) as unknown as typeof fetch,
    signal: new AbortController().signal,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...over,
    sleeps,
    saved
  }
}

/** Deletes every occurrence directory that `testContext` created. */
export async function removeTestContexts(): Promise<void> {
  await Promise.all(occurrences.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}
