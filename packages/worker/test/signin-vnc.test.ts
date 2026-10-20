import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { idleMs, startVnc, vncArgs } from '../src/control/vnc'

const desk = { x: 1920, y: 0, width: 1920, height: 1080 }

test('the VNC view is clipped to the desk, bound to localhost and asks for a password file', () => {
  expect(vncArgs(':99', desk, '/run/tm-vnc-x/passwd')).toEqual({
    x11vnc: [
      '-display',
      ':99',
      '-clip',
      '1920x1080+1920+0',
      '-rfbport',
      '5900',
      '-localhost',
      '-passwdfile',
      '/run/tm-vnc-x/passwd',
      '-forever',
      '-shared',
      '-noxdamage',
      '-quiet'
    ],
    websockify: ['0.0.0.0:6080', 'localhost:5900']
  })
})

test('a view-only view says so, and an open one never does', () => {
  expect(vncArgs(':99', desk, '/p', { viewOnly: true }).x11vnc).toContain('-viewonly')
  expect(vncArgs(':99', desk, '/p').x11vnc).not.toContain('-viewonly')
})

let bin: string
let dump: string
let savedPath: string | undefined

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const listens = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)))
  })

// Stand-ins for x11vnc and websockify: they write what they were given to $FAKE_DUMP/<name>.json and listen on the
// port they were told, as the real ones do.
const fakeProgram = (name: string, portExpr: string, extra: string) => `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const port = ${portExpr}
const seen = { args, ${extra} }
fs.writeFileSync(process.env.FAKE_DUMP + '/${name}.json', JSON.stringify(seen))
require('node:net').createServer().listen(port, '127.0.0.1')
`

beforeEach(async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-vnc-test-'))
  bin = join(root, 'bin')
  dump = join(root, 'dump')
  await mkdir(bin)
  await mkdir(dump)
  await writeFile(
    join(bin, 'x11vnc'),
    fakeProgram(
      'x11vnc',
      "Number(args[args.indexOf('-rfbport') + 1])",
      "passwd: fs.readFileSync(args[args.indexOf('-passwdfile') + 1], 'utf8'), mode: fs.statSync(args[args.indexOf('-passwdfile') + 1]).mode & 0o777, file: args[args.indexOf('-passwdfile') + 1]"
    )
  )
  await writeFile(join(bin, 'websockify'), fakeProgram('websockify', "Number(args[0].split(':')[1])", 'x: 1'))
  await writeFile(join(bin, 'xprintidle'), '#!/bin/sh\necho "${XPRINTIDLE_OUT:-1234}"\n')
  for (const name of ['x11vnc', 'websockify', 'xprintidle']) await chmod(join(bin, name), 0o755)
  savedPath = process.env.PATH
  process.env.PATH = `${bin}:${savedPath}`
  process.env.FAKE_DUMP = dump
})

afterEach(async () => {
  process.env.PATH = savedPath
  delete process.env.FAKE_DUMP
  delete process.env.XPRINTIDLE_OUT
  await rm(join(bin, '..'), { recursive: true, force: true })
})

test('the view keeps its password in a private file, out of the command lines, and removes it when it stops', async () => {
  const vncPort = await freePort()
  const wsPort = await freePort()
  const stopper = await startVnc(':99', desk, 'S3cr3t!!', { vncPort, wsPort })
  const x11vnc = JSON.parse(await readFile(join(dump, 'x11vnc.json'), 'utf8')) as {
    args: string[]
    passwd: string
    mode: number
    file: string
  }
  const websockify = JSON.parse(await readFile(join(dump, 'websockify.json'), 'utf8')) as { args: string[] }
  expect(x11vnc.passwd).toBe('S3cr3t!!\n')
  expect(x11vnc.mode).toBe(0o600)
  expect(x11vnc.args).toContain('-localhost')
  expect(websockify.args).toEqual([`0.0.0.0:${wsPort}`, `localhost:${vncPort}`])
  expect(JSON.stringify([x11vnc.args, websockify.args])).not.toContain('S3cr3t')
  expect((await stat(x11vnc.file)).isFile()).toBe(true)
  expect(await listens(vncPort)).toBe(true)

  await stopper.stop()
  await stopper.stop() // twice is safe
  await expect(stat(x11vnc.file)).rejects.toThrow()
  expect(await listens(vncPort)).toBe(false)
  expect(await listens(wsPort)).toBe(false)
})

test('a view whose x11vnc is missing fails and leaves no password file behind', async () => {
  await rm(join(bin, 'x11vnc'))
  process.env.PATH = bin
  const before = process.env.XDG_RUNTIME_DIR
  const runtime = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-vnc-run-'))
  process.env.XDG_RUNTIME_DIR = runtime
  try {
    await expect(
      startVnc(':99', desk, 'S3cr3t!!', { vncPort: await freePort(), wsPort: await freePort() })
    ).rejects.toThrow('cannot start x11vnc')
    expect(await readdir(runtime)).toEqual([])
  } finally {
    if (before === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = before
    await rm(runtime, { recursive: true, force: true })
  }
})

test('idle time is what xprintidle prints for the display', async () => {
  process.env.XPRINTIDLE_OUT = '4321'
  expect(await idleMs(':99')).toBe(4321)
  process.env.XPRINTIDLE_OUT = 'nope'
  await expect(idleMs(':99')).rejects.toThrow('not a number')
})
