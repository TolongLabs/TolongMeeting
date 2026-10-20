import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNtfyLine, startNtfySubscriber, type NtfyMessage } from '../src/ntfy'
import { StateStore } from '../src/state'

// One live check against the ntfy 2.32 server of spikes/08-ntfy, run as a throwaway container (no root needed, only
// access to Docker). It skips with a reason when Docker or the image is missing.

const IMAGE = 'binwiederhier/ntfy:v2.32.0'

function docker(...args: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() }
  } catch {
    return { ok: false, out: 'docker is not installed' }
  }
}

const probe = docker('image', 'inspect', IMAGE)
const skipReason = probe.ok ? null : `Docker or the image ${IMAGE} is not available here`
if (skipReason !== null) console.warn(`ntfy live test skipped: ${skipReason}`)

describe.skipIf(skipReason !== null)('live ntfy 2.32', () => {
  let container = ''
  let url = ''
  let token = ''
  let dir = ''

  beforeAll(async () => {
    const run = docker(
      ...['run', '-d', '--rm', '-p', '127.0.0.1::80']
        // Auth on and everything denied by default, like the production server.
        .concat(['-e', 'NTFY_AUTH_FILE=/tmp/user.db', '-e', 'NTFY_AUTH_DEFAULT_ACCESS=deny-all'])
        .concat([IMAGE, 'serve'])
    )
    if (!run.ok) throw new Error(`could not start ntfy: ${run.out}`)
    container = run.out.split('\n').at(-1) as string
    const port = docker('port', container, '80/tcp').out.match(/127\.0\.0\.1:(\d+)/)?.[1]
    if (port === undefined) throw new Error('no published port')
    url = `http://127.0.0.1:${port}`
    for (let i = 0; ; i++) {
      if ((await fetch(`${url}/v1/health`).catch(() => null))?.ok) break
      if (i > 100) throw new Error('ntfy did not start')
      await Bun.sleep(100)
    }
    const add = docker('exec', '-e', 'NTFY_PASSWORD=pw', container, 'ntfy', 'user', 'add', '--role=admin', 'admin')
    if (!add.ok) throw new Error(`user add failed: ${add.out}`)
    const tok = docker('exec', container, 'ntfy', 'token', 'add', 'admin')
    token = tok.out.match(/tk_[A-Za-z0-9]+/)?.[0] ?? ''
    if (token === '') throw new Error(`token add failed: ${tok.out}`)
    dir = await mkdtemp(join(tmpdir(), 'tm-ntfy-live-'))
  }, 60_000)

  afterAll(async () => {
    if (container !== '') docker('rm', '-f', container)
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  }, 60_000)

  const publish = (body: object) =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'tm-live', ...body })
    })

  test('real stream lines parse, and the subscriber receives, resumes and rejects a bad token', async () => {
    const got: NtfyMessage[] = []
    const errors: Error[] = []
    const state = new StateStore(join(dir, 'state.json'))
    const sub = startNtfySubscriber({
      cfg: { url, topic: 'tm-live', token },
      state,
      onMessage: (m) => got.push(m),
      onError: (e) => errors.push(e),
      delayMs: () => 50
    })
    await Bun.sleep(500) // let the stream open before publishing
    const res = await publish({
      title: 'Summary ready: CS6013',
      message: 'Tap to open',
      priority: 4,
      tags: ['tm_summary'],
      actions: [{ action: 'view', label: 'Open', url: 'https://tm.example/meetings/1', clear: false }]
    })
    expect(res.status).toBe(200)
    const end = Date.now() + 5000
    while (state.get().ntfyLastId === null && Date.now() < end) await Bun.sleep(20)
    sub.stop()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ title: 'Summary ready: CS6013', priority: 4, tags: ['tm_summary'] })
    expect(got[0].actions?.[0]).toMatchObject({ action: 'view', label: 'Open' })
    expect(state.get().ntfyLastId).toBe(got[0].id)
    expect(errors.filter((e) => e.message.startsWith('dropped'))).toEqual([])

    // A later run resumes after the saved id: it replays nothing.
    const again: NtfyMessage[] = []
    const second = startNtfySubscriber({
      cfg: { url, topic: 'tm-live', token },
      state,
      onMessage: (m) => again.push(m),
      delayMs: () => 50
    })
    await Bun.sleep(500)
    second.stop()
    expect(again).toEqual([])

    // The raw JSON lines of the server parse with the strict schema, keepalives and open events included.
    const raw = await fetch(`${url}/tm-live/json?poll=1&since=all`, { headers: { Authorization: `Bearer ${token}` } })
    const lines = (await raw.text()).trim().split('\n')
    expect(lines.map(parseNtfyLine).filter((m) => m !== null)).toHaveLength(1)

    const bad: Error[] = []
    const rejected = startNtfySubscriber({
      cfg: { url, topic: 'tm-live', token: 'tk_wrongwrongwrongwrongwrongwrong1' },
      state,
      onMessage: () => {},
      onError: (e) => bad.push(e),
      delayMs: () => 50
    })
    const wait = Date.now() + 5000
    while (bad.length === 0 && Date.now() < wait) await Bun.sleep(20)
    rejected.stop()
    expect(bad[0].message).toBe('ntfy answered 401')
  }, 30_000)
})
