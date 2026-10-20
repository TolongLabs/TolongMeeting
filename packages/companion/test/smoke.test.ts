import { type ChildProcess, spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Starts the real Electron binary and checks that the headless shell boots, loads its settings and quits cleanly.
// It needs the binary (`bun run electron:install`) and a display, so it runs only when asked:
//   TM_ELECTRON_SMOKE=1 xvfb-run -a bun test packages/companion/test/smoke.test.ts
// `--no-sandbox` is for this test only (the dev container has no setuid sandbox); the app never sets it.
const enabled = process.env.TM_ELECTRON_SMOKE === '1'

const READY = 'tm-companion ready'
let work = ''
let main = ''
let electron = ''
const children: ChildProcess[] = []

function launch(): { child: ChildProcess; lines: string[]; exited: Promise<number | null> } {
  const child = spawn(electron, ['--no-sandbox', main], {
    env: { ...process.env, XDG_CONFIG_HOME: join(work, 'config') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)
  const lines: string[] = []
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream.on('data', (chunk: Buffer) => {
      const parts = (pending + chunk.toString()).split('\n')
      pending = parts.pop() ?? ''
      lines.push(...parts)
    })
  }
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, lines, exited }
}

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

describe.skipIf(!enabled)('headless Electron smoke test', () => {
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'tm-companion-smoke-'))
    // In a subprocess: `Bun.build` fails to resolve the imports when it is called from inside `bun test`.
    const built = Bun.spawnSync(['bun', join(import.meta.dir, '../scripts/build.ts'), join(work, 'dist')], {
      env: { ...process.env, TM_PUBLIC_URL: 'https://tm.example' }
    })
    if (built.exitCode !== 0) throw new Error(`the build failed: ${built.stderr.toString()}`)
    main = join(work, 'dist/main/index.cjs')
    const electronDir = dirname(Bun.resolveSync('electron/package.json', join(import.meta.dir, '..')))
    electron = join(electronDir, 'dist', (await readFile(join(electronDir, 'path.txt'), 'utf8')).trim())
    const userData = join(work, 'config', 'TolongMeeting')
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ summariesDir: join(work, 'notes') }))
  })

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
    await rm(work, { recursive: true, force: true })
  })

  test('starts, loads settings, refuses a second copy and quits on SIGTERM', async () => {
    const first = launch()
    await until('the ready line', () => first.lines.some((l) => l.startsWith(READY)))
    expect(first.lines.find((l) => l.startsWith(READY))).toBe(`${READY}: summaries in ${join(work, 'notes')}`)

    const second = launch()
    expect(await second.exited).toBe(0)
    expect(second.lines.some((l) => l.startsWith(READY))).toBe(false)

    first.child.kill('SIGTERM')
    expect(await first.exited).toBe(0)
  }, 90_000)

  test('a malformed settings file stops the app with an error', async () => {
    await writeFile(join(work, 'config', 'TolongMeeting', 'settings.json'), '{"whisper":{"model":5}}')
    const run = launch()
    expect(await run.exited).toBe(1)
    expect(run.lines.some((l) => l.startsWith(READY))).toBe(false)
  }, 60_000)
})
