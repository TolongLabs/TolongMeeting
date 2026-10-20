import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const dir = join(import.meta.dir, '..', '..', '..', 'docker', 'home-route')
const root = join(import.meta.dir, '..', '..', '..')
const text = (path: string) => Bun.file(path).text()

const ID = 'nHOME1CNTRL'
const HOST = 'tm-home-0123456789abcdef01234567'
const peer = (o: Record<string, unknown>) => ({
  ID,
  HostName: HOST,
  ExitNodeOption: true,
  Online: true,
  TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  ...o
})
const status = (peers: Record<string, unknown>, exit: Record<string, unknown> | null = null) =>
  JSON.stringify({ BackendState: 'Running', Peer: peers, ...(exit ? { ExitNodeStatus: exit } : {}) })

async function run(args: string[], stdin: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(['sh', join(dir, 'exit-node.sh'), ...args], {
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH!, TM_EXIT_NODE_ID: ID, TM_EXIT_NODE_HOSTNAME: HOST, ...env }
  })
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: out.trim() }
}

// jq is in the sidecar image and on CI; a machine without it can't run these, and CI must not skip them silently.
const haveJq = Bun.which('jq') !== null
if (!haveJq && process.env.CI) throw new Error('jq is required for the home-route script tests')
const jqTest = haveJq ? test : test.skip

describe('exit-node.sh: the sidecar picks the member home node by id and keyed hostname', () => {
  jqTest('selects the peer with the stored node id AND the keyed hostname', async () => {
    const r = await run(['select'], status({ k1: peer({}) }))
    expect(r).toEqual({ code: 0, out: '100.101.102.103' })
  })

  jqTest('ignores a device that registered the same hostname under another node id', async () => {
    const decoy = peer({ ID: 'nEVIL', TailscaleIPs: ['100.64.0.9'] })
    expect((await run(['select'], status({ k2: decoy }))).code).toBe(1)
    // With the real node present as well, only the real node's address comes out.
    expect(await run(['select'], status({ k1: peer({}), k2: decoy }))).toEqual({ code: 0, out: '100.101.102.103' })
  })

  jqTest(
    'ignores the stored node id under another hostname, an offline node and a node that is no exit node',
    async () => {
      for (const bad of [
        { HostName: 'tm-home-ffffffffffffffffffffffff' },
        { Online: false },
        { ExitNodeOption: false }
      ]) {
        expect((await run(['select'], status({ k1: peer(bad) }))).code).toBe(1)
      }
    }
  )

  jqTest('verify passes only for that node, online, in use as the exit node', async () => {
    const ok = status({ k1: peer({}) }, { ID, Online: true, TailscaleIPs: ['100.101.102.103/32'] })
    expect((await run(['verify', '100.101.102.103'], ok)).code).toBe(0)
    const wrongNode = status({ k1: peer({}) }, { ID: 'nEVIL', Online: true, TailscaleIPs: ['100.64.0.9/32'] })
    expect((await run(['verify', '100.101.102.103'], wrongNode)).code).not.toBe(0)
    const offline = status({ k1: peer({}) }, { ID, Online: false, TailscaleIPs: ['100.101.102.103/32'] })
    expect((await run(['verify', '100.101.102.103'], offline)).code).not.toBe(0)
    const none = status({ k1: peer({}) })
    expect((await run(['verify', '100.101.102.103'], none)).code).not.toBe(0)
  })

  jqTest('needs the stored node, so it never runs without one', async () => {
    const r = await run(['select'], status({ k1: peer({}) }), { TM_EXIT_NODE_ID: '' })
    expect(r.code).not.toBe(0)
  })
})

describe('start.sh and the image', () => {
  test('the scripts parse', async () => {
    for (const f of ['start.sh', 'exit-node.sh']) {
      const p = Bun.spawn(['sh', '-n', join(dir, f)], { stderr: 'pipe' })
      expect(await p.exited).toBe(0)
    }
  })

  test('deny-private runs on tailscale0 before containerboot starts', async () => {
    const lines = (await text(join(dir, 'start.sh'))).split('\n').filter((l) => !l.trimStart().startsWith('#'))
    const deny = lines.findIndex((l) => l.includes('deny-private.sh --out-iface tailscale0'))
    const boot = lines.findIndex((l) => l.trim() === 'containerboot &')
    expect(deny).toBeGreaterThanOrEqual(0)
    expect(boot).toBeGreaterThan(deny)
    // `set -e` is on, so a failing deny-private ends the container before containerboot.
    expect(lines.findIndex((l) => l.trim() === 'set -eu')).toBeLessThan(deny)
  })

  test('the exit node is chosen by the script, never from the environment as an address', async () => {
    const start = await text(join(dir, 'start.sh'))
    expect(start).toContain('exit-node.sh select')
    expect(start).toContain('tailscale set --exit-node="$ip"')
    expect(start).not.toMatch(/exit-node=\$\{?TM_|--exit-node=1/)
  })

  test('the auth key is read from a file, never from the environment or an argument', async () => {
    const files = await Promise.all(['start.sh', 'exit-node.sh', 'Dockerfile'].map((f) => text(join(dir, f))))
    for (const f of files) expect(f).not.toMatch(/tskey-|--auth-?key|TS_AUTHKEY=\$/)
  })

  test('the image pins Tailscale by build argument and copies the egress script', async () => {
    const docker = await text(join(dir, 'Dockerfile'))
    expect(docker).toContain('ARG TAILSCALE_VERSION')
    expect(docker).toContain('FROM tailscale/tailscale:v${TAILSCALE_VERSION}')
    expect(docker).toContain('docker/egress/deny-private.sh')
    expect(docker).toContain('ENTRYPOINT ["/usr/local/bin/start.sh"]')
  })

  test('TAILSCALE_VERSION is an exact version, and the compose file builds and runs that tag only', async () => {
    const versions = await text(join(root, 'docker', 'worker', 'versions.env'))
    expect(versions).toMatch(/^TAILSCALE_VERSION=\d+\.\d+\.\d+$/m)
    const compose = await text(join(root, 'docker', 'compose.yaml'))
    expect(compose).toContain('image: tm-home-route:${TAILSCALE_VERSION:?')
    expect(compose).toContain('dockerfile: docker/home-route/Dockerfile')
    expect(compose.match(/TAILSCALE_VERSION: \$\{TAILSCALE_VERSION:\?/g)).toHaveLength(3)
  })
})
