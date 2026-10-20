// docker/egress/deny-private.sh: private-range egress rules for runs that skip the server firewall (local holder,
// home-route sidecar). `--print` is checked as text; the real rules are applied with iptables inside `unshare -Urn`
// (a throwaway user and network namespace, no root needed). Without unshare the real-iptables tests skip, and in CI
// (CI is set) they fail instead.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'docker', 'egress', 'deny-private.sh')
const CHAIN = 'TM-DENY-PRIVATE'

const run = (...args: string[]) => {
  const p = Bun.spawnSync(['bash', SCRIPT, '--print', ...args])
  return { code: p.exitCode, lines: p.stdout.toString().trim().split('\n'), stderr: p.stderr.toString() }
}
const print = (...args: string[]) => run(...args).lines

const V4 = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
  '127.0.0.0/8',
  '192.0.0.0/24',
  '198.18.0.0/15',
  '224.0.0.0/3'
]
const V6 = ['::/128', 'fe80::/10', 'fc00::/7', 'fec0::/10', '::ffff:0:0/96', '64:ff9b::/96', 'ff00::/8']

describe('--print', () => {
  test('local holder rules: allow the relay first, then replies and loopback, then reject every private range', () => {
    expect(print('--allow-tcp', '192.168.65.254:41234')).toEqual([
      `iptables -A ${CHAIN} -p tcp -d 192.168.65.254 --dport 41234 -j ACCEPT`,
      `iptables -A ${CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
      `iptables -A ${CHAIN} -o lo -j ACCEPT`,
      ...V4.map((r) => `iptables -A ${CHAIN} -d ${r} -j REJECT`),
      `iptables -I OUTPUT 1 -j ${CHAIN}`,
      `ip6tables -A ${CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
      `ip6tables -A ${CHAIN} -o lo -j ACCEPT`,
      ...V6.map((r) => `ip6tables -A ${CHAIN} -d ${r} -j REJECT`),
      `ip6tables -I OUTPUT 1 -j ${CHAIN}`
    ])
  })

  test('the ranges match the server firewall (docker/firewall/worker-egress.sh)', async () => {
    const server = await Bun.file(join(import.meta.dir, '..', 'docker', 'firewall', 'worker-egress.sh')).text()
    const deny = /^DENY=(\S+)$/m.exec(server)![1]!.split(',')
    expect(V4.toSorted()).toEqual(deny.toSorted())
    const rejected = print().filter((l) => l.startsWith('iptables -A') && l.endsWith('-j REJECT'))
    expect(rejected).toHaveLength(deny.length)
  })

  test('the relay stays reachable: every ACCEPT for it comes before the first REJECT', () => {
    const lines = print('--allow-tcp', '10.1.2.3:8080', '--allow-tcp', '10.1.2.4:9')
    const firstReject = lines.findIndex((l) => l.endsWith('-j REJECT'))
    const accepts = lines.flatMap((l, i) => (l.includes('--dport') ? [i] : []))
    expect(accepts).toHaveLength(2)
    expect(Math.max(...accepts)).toBeLessThan(firstReject)
  })

  test('home-route rules apply to the tunnel interface only', () => {
    const lines = print('--out-iface', 'tailscale0')
    expect(lines[0]).toBe(`iptables -A ${CHAIN} -o tailscale0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`)
    expect(lines).toContain(`iptables -A ${CHAIN} -o tailscale0 -d 10.0.0.0/8 -j REJECT`)
    expect(lines).toContain(`ip6tables -A ${CHAIN} -o tailscale0 -d fc00::/7 -j REJECT`)
    // Loopback is not touched, so no rule accepts it and every rule names the interface.
    expect(lines.filter((l) => l.includes(' -A '))).toSatisfy((rules: string[]) =>
      rules.every((l) => l.includes('-o tailscale0 '))
    )
    expect(lines.some((l) => l.includes('-o lo'))).toBe(false)
  })

  test('a host name is printed as given and not resolved; --hold ends with exec sleep infinity', () => {
    const lines = print('--allow-tcp', 'host.docker.internal:41234', '--hold')
    expect(lines[0]).toBe(`iptables -A ${CHAIN} -p tcp -d host.docker.internal --dport 41234 -j ACCEPT`)
    // --print shows the hold step, so it shows the ready line as a command too (it is never run).
    expect(lines.slice(-2)).toEqual(["echo 'deny-private: ready'", 'exec sleep infinity'])
    expect(print().join('\n')).not.toMatch(/exec sleep infinity|deny-private: ready/)
  })

  test.each([
    [['--allow-all']],
    [['--out-iface']],
    [['--allow-tcp']],
    [['--allow-tcp', 'nocolon']],
    [['--allow-tcp', '10.0.0.1:0']],
    [['--allow-tcp', '10.0.0.1:70000']],
    [['--allow-tcp', 'a b:80']],
    [['--out-iface', 'eth0;reboot']],
    [['--out-iface', 'a-name-longer-than-15']]
  ])('bad arguments %p fail with a non-zero status and print no rules', (args) => {
    const r = run(...args)
    expect(r.code).not.toBe(0)
    expect(r.lines.join('\n')).not.toContain('iptables')
  })
})

/** Run a shell snippet in a new user and network namespace (root inside it), with a stub dir first on PATH. */
const inNamespace = (script: string, env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(['unshare', '-Urn', 'sh', '-c', script], { env: { ...process.env, ...env } })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const checkNamespaces = Bun.spawnSync(['unshare', '-Urn', 'iptables', '-w', '30', '-L', '-n'], {
  stdout: 'ignore',
  stderr: 'pipe'
})
const namespaces = checkNamespaces.exitCode === 0
if (!namespaces) {
  const msg = `deny-private: unshare -Urn with iptables is unavailable (exit ${checkNamespaces.exitCode}): ${checkNamespaces.stderr.toString().trim()}`
  if (!process.env.CI) console.warn(`${msg}; real-rule tests skipped`)
  else console.error(`${msg}; forced in CI`)
}
const real = namespaces || process.env.CI ? describe : describe.skip

const scratch = mkdtempSync(join(tmpdir(), 'tm-deny-private-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const apply = `sh ${SCRIPT}`
/** Lines of `iptables -S` / `ip6tables -S` for the chain and the OUTPUT chain after the commands ran. */
const dump = (commands: string) =>
  inNamespace(
    `${commands} && iptables -S ${CHAIN} && echo '#6' && ip6tables -S ${CHAIN} && echo '#out' && iptables -S OUTPUT && ip6tables -S OUTPUT`
  )

const expectSuccess = (res: { code: number; err: string; out: string }) => {
  if (res.code !== 0 && res.err.trim()) {
    console.error(`Command failed with exit ${res.code}:\n${res.err}`)
  }
  expect(res.code, res.err).toBe(0)
}

real('real iptables in a throwaway namespace', () => {
  test('applies the ranges for IPv4 and IPv6, hooks OUTPUT first, and is unchanged by a re-run', () => {
    const once = dump(`${apply} --allow-tcp 192.168.65.254:41234`)
    expectSuccess(once)
    const twice = dump(`${apply} --allow-tcp 192.168.65.254:41234 && ${apply} --allow-tcp 192.168.65.254:41234`)
    expectSuccess(twice)
    expect(twice.out).toBe(once.out)

    const [v4, rest] = once.out.split('#6\n')
    const [v6, out] = rest!.split('#out\n')
    expect(v4).toContain('-A TM-DENY-PRIVATE -d 192.168.65.254/32 -p tcp -m tcp --dport 41234 -j ACCEPT')
    for (const r of V4) expect(v4).toContain(`-d ${r} -j REJECT`)
    // ip6tables -S prints the v4-mapped prefix in dotted form.
    for (const r of V6) expect(v6).toContain(`-d ${r.replace('::ffff:0:0', '::ffff:0.0.0.0')} -j REJECT`)
    expect(v4.trimEnd().split('\n').at(-1)).toContain('-d 224.0.0.0/3 -j REJECT')
    expect(v6.trimEnd().split('\n').at(-1)).toContain('-d ff00::/8 -j REJECT')
    // `-S OUTPUT` prints `-P OUTPUT ACCEPT` first, then the rules: the jump must be the first rule, once per family.
    expect(out!.match(/^-A OUTPUT -j TM-DENY-PRIVATE$/gm)).toHaveLength(2)
    expect(out!.split('\n')[1]).toBe('-A OUTPUT -j TM-DENY-PRIVATE')
  })

  test('a re-run with other options replaces the chain: the old relay rule is gone, the new one is there', () => {
    const r = dump(`${apply} --allow-tcp 192.168.65.254:41234 && ${apply} --allow-tcp 192.168.65.1:5555`)
    expectSuccess(r)
    expect(r.out).not.toContain('41234')
    expect(r.out).toContain('-d 192.168.65.1/32 -p tcp -m tcp --dport 5555 -j ACCEPT')
    expect(r.out.match(/--dport/g)).toHaveLength(1)
  })

  test('--out-iface limits every rule to that interface and leaves loopback alone', () => {
    const r = dump(`${apply} --out-iface tailscale0`)
    expectSuccess(r)
    const rules = r.out
      .split('#out\n')[0]!
      .split('\n')
      .filter((l) => l.startsWith('-A TM-DENY-PRIVATE'))
    expect(rules).toHaveLength(2 + V4.length + V6.length) // replies rule + ranges, v4 and v6 listed together
    expect(rules.every((l) => l.includes('-o tailscale0'))).toBe(true)
    expect(r.out).not.toContain('-o lo')
  })

  test('resolves a host name with getent ahostsv4 and allows each address it returns', () => {
    // A throwaway namespace has no IPv4 address, which makes getaddrinfo drop IPv4 answers: give lo one first.
    const r = inNamespace(
      `ip link set lo up && ip addr add 10.77.0.1/32 dev lo && ${apply} --allow-tcp localhost:5 && iptables -S ${CHAIN}`
    )
    expectSuccess(r)
    expect(r.out).toContain('-A TM-DENY-PRIVATE -d 127.0.0.1/32 -p tcp -m tcp --dport 5 -j ACCEPT')
  })

  test('fails closed on a name that does not resolve: exit non-zero, no chain, no hook, nothing held', () => {
    const r = inNamespace(
      `${apply} --allow-tcp no-such-host.invalid:5 --hold; echo "code=$?"; iptables -S OUTPUT; iptables -S ${CHAIN} 2>&1`
    )
    if (!r.out.match(/code=[1-9]/) && r.err.trim()) {
      console.error(`Command unexpected failure:\n${r.err}`)
    }
    expect(r.out, r.err).toMatch(/code=[1-9]/)
    expect(r.err).toContain('cannot resolve no-such-host.invalid')
    expect(r.out).not.toContain(CHAIN + ' ')
    expect(r.out).not.toContain('-j TM-DENY-PRIVATE')
  })

  test('IPv6 may be skipped only when IPv6 is disabled; otherwise a missing ip6tables is fatal', () => {
    const stub = join(scratch, 'bin')
    Bun.spawnSync(['mkdir', '-p', stub])
    for (const tool of ['ip6tables', 'ip6tables-restore']) {
      writeFileSync(join(stub, tool), '#!/bin/sh\necho "stub: no ip6tables support" >&2\nexit 1\n')
      chmodSync(join(stub, tool), 0o755)
    }
    const path = `${stub}:${process.env.PATH}`
    const fatal = inNamespace(`${apply}; echo "code=$?"`, { PATH: path })
    if (!fatal.out.match(/code=[1-9]/) && fatal.err.trim()) {
      console.error(`Command unexpected failure:\n${fatal.err}`)
    }
    expect(fatal.out, fatal.err).toMatch(/code=[1-9]/)
    expect(fatal.err).toContain('IPv6 is not disabled')

    const disabled = inNamespace(
      `echo 1 > /proc/sys/net/ipv6/conf/all/disable_ipv6 && ${apply}; echo "code=$?"; iptables -S ${CHAIN} | tail -n 1`,
      { PATH: path }
    )
    if (!disabled.out.includes('code=0') && disabled.err.trim()) {
      console.error(`Command unexpected failure:\n${disabled.err}`)
    }
    expect(disabled.out, disabled.err).toContain('code=0')
    expect(disabled.out).toContain('-d 224.0.0.0/3 -j REJECT')
    expect(disabled.err).toContain('IPv6 rules skipped')
  })

  test('--hold prints one ready line, last, after every rule is in and checked', () => {
    const out = join(scratch, 'ready.out')
    // Wait for the line in the file, list the chains at that moment, then stop the holder (`$!` is the sleep it exec'd).
    const r = inNamespace(
      `${apply} --allow-tcp 192.168.65.254:41234 --hold > ${out} & pid=$!; ` +
        `i=0; while ! grep -q '^deny-private: ready$' ${out} && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; ` +
        `iptables -S ${CHAIN} | grep -c '^-A'; ip6tables -S ${CHAIN} | grep -c '^-A'; ` +
        `iptables -S OUTPUT | sed -n 2p; ip6tables -S OUTPUT | sed -n 2p; kill $pid`
    )
    expectSuccess(r)
    const [v4, v6, hook4, hook6] = r.out.trim().split('\n')
    expect(Number(v4)).toBe(1 + 1 + 1 + V4.length) // relay, replies, loopback, ranges
    expect(Number(v6)).toBe(1 + 1 + V6.length)
    expect([hook4, hook6]).toEqual(['-A OUTPUT -j TM-DENY-PRIVATE', '-A OUTPUT -j TM-DENY-PRIVATE'])
    expect(readFileSync(out, 'utf8')).toBe('deny-private: ready\n')
  })

  test('a failing --hold run never prints the ready line and never holds', () => {
    const unresolved = inNamespace(`timeout 10 ${apply} --allow-tcp no-such-host.invalid:5 --hold; echo "code=$?"`)
    if (!unresolved.out.match(/code=1\b/) && unresolved.err.trim()) {
      console.error(`Command unexpected failure:\n${unresolved.err}`)
    }
    expect(unresolved.out, unresolved.err).toMatch(/code=1\b/)
    expect(unresolved.out).not.toContain('ready')

    const stub = join(scratch, 'bin-fail')
    Bun.spawnSync(['mkdir', '-p', stub])
    for (const tool of ['ip6tables', 'ip6tables-restore']) {
      writeFileSync(join(stub, tool), '#!/bin/sh\necho "stub: no ip6tables support" >&2\nexit 1\n')
      chmodSync(join(stub, tool), 0o755)
    }
    // IPv4 rules go in, then IPv6 is fatal: the ready line must not have been printed before that.
    const late = inNamespace(`timeout 10 ${apply} --hold; echo "code=$?"`, { PATH: `${stub}:${process.env.PATH}` })
    if (!late.out.match(/code=1\b/) && late.err.trim()) {
      console.error(`Command unexpected failure:\n${late.err}`)
    }
    expect(late.out, late.err).toMatch(/code=1\b/)
    expect(late.out).not.toContain('ready')
    expect(late.err).toContain('IPv6 is not disabled')
  })

  test('--hold keeps the namespace alive only after the rules are in', async () => {
    const p = Bun.spawn(
      ['unshare', '-Urn', 'sh', '-c', `${apply} --hold & pid=$!; sleep 1; iptables -S ${CHAIN} | wc -l; kill $pid`],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const out = await new Response(p.stdout).text()
    const err = await new Response(p.stderr).text()
    const code = await p.exited
    const lines = out.trim().split('\n')
    if (lines[0] !== 'deny-private: ready' && err.trim()) {
      console.error(`--hold failed (exit ${code}):\n${err}`)
    }
    // stdout is the ready line, then the rule count.
    expect(lines, err).toEqual(['deny-private: ready', String(1 + 2 + V4.length)])
  })
})
