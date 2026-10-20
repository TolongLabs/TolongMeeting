import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { nodeSpawn, type SpawnLike } from '../src/jobs/whisper'
import {
  checkRunArgs,
  DockerError,
  dockerCli,
  findDocker,
  imageRefOk,
  normalizeHostPath,
  UnsafeDockerInput,
  type DockerCliOptions
} from '../src/local/docker'

const PREFIX = 'ghcr.io/tl/'
/** The app's own tree, as `localPaths(%LOCALAPPDATA%).root` gives it. */
const ROOTS = ['C:\\TM']
const DOCKER = 'C:\\Program Files\\Docker\\docker.exe'
const check = (args: string[], prefix = PREFIX, roots: readonly string[] = ROOTS) => checkRunArgs(args, prefix, roots)
const cli = (spawn: SpawnLike, over: Partial<DockerCliOptions> = {}) =>
  dockerCli(spawn, { imagePrefix: PREFIX, allowedRoots: ROOTS, dockerPath: DOCKER, ...over })
const REF = 'ghcr.io/tl/tolongmeeting-worker:1.0.0'
const DIGEST = `ghcr.io/tl/tolongmeeting-worker@sha256:${'a1'.repeat(32)}`

type Answer = { code?: number; out?: string; err?: string; throws?: Error }
/** A `SpawnLike` that answers from `answer(args)` and records every call. */
function fakeSpawn(answer: (args: string[]) => Answer) {
  const calls: { cmd: string; args: string[]; opts: unknown }[] = []
  const spawn: SpawnLike = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const a = answer(args)
    if (a.throws) throw a.throws
    return {
      exited: Promise.resolve(a.code ?? 0),
      stdout: () => a.out ?? '',
      stderrTail: () => a.err ?? '',
      kill: () => {}
    }
  }
  return { spawn, calls }
}

// The worker's argument list as plan 08 Task 8 writes it, plus the hardening the driver requires.
const HARDENING = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '2048']
const workerArgs = (over: string[] = []): string[] => [
  'run',
  '-d',
  '--rm',
  '--name',
  'tm-run-o1-2',
  '--label',
  'tm.identity=u1',
  '--shm-size=2g',
  '--network',
  'container:tm-net-o1',
  ...HARDENING,
  '-v',
  'tm-profile-u1:/tm/profiles/u1/vol',
  '-v',
  'C:\\TM\\profiles\\u1\\checkpoints:/tm/profiles/u1/checkpoints',
  '-v',
  'C:\\TM\\data:/tm/data',
  '-v',
  'C:\\TM\\runs\\r1:/run/tm:ro',
  '-v',
  'C:\\TM\\machine-ids\\u1:/etc/machine-id:ro',
  '-e',
  'TM_DATA_ROOT=/tm/data',
  ...over,
  REF,
  'tm-worker',
  '--job',
  '/run/tm/job.json'
]

describe('image references', () => {
  test('only registry/name@sha256 or registry/name:tag pass', () => {
    expect(imageRefOk(REF)).toBe(true)
    expect(imageRefOk(DIGEST)).toBe(true)
    expect(imageRefOk('localhost:5000/tm/worker:dev')).toBe(true)
    for (const bad of [
      '',
      'worker:1',
      'tm/worker:1',
      'ghcr.io/tl/worker',
      'ghcr.io/tl/worker:latest;rm',
      'ghcr.io/tl/worker:1 --privileged',
      '--privileged',
      '-v/:/host',
      'ghcr.io/TL/worker:1',
      'ghcr.io/tl/worker@sha256:abc',
      `ghcr.io/tl/worker:1@sha256:${'a1'.repeat(32)}`,
      'https://ghcr.io/tl/worker:1',
      'ghcr.io/tl/../worker:1',
      `ghcr.io/tl/${'a'.repeat(300)}:1`
    ]) {
      expect(imageRefOk(bad)).toBe(false)
    }
  })
  test('a prefix limits the repository', () => {
    expect(imageRefOk(REF, 'ghcr.io/tl/')).toBe(true)
    expect(imageRefOk('ghcr.io/evil/worker:1', 'ghcr.io/tl/')).toBe(false)
    expect(imageRefOk('ghcr.io/tl.evil.io/worker:1', 'ghcr.io/tl/')).toBe(false)
  })
})

describe('run arguments', () => {
  test('the fixed template passes', () => {
    expect(() => check(workerArgs())).not.toThrow()
  })
  test('the holder shape passes: NET_ADMIN, user 0, noVNC on 127.0.0.1 only', () => {
    expect(() =>
      check([
        'run',
        '-d',
        '--name',
        'tm-net-o1',
        '--network',
        'tm-local',
        '--hostname',
        'tm-u1',
        ...HARDENING,
        '--cap-add',
        'NET_ADMIN',
        '--user',
        '0',
        '-p',
        '127.0.0.1::6080',
        '--entrypoint',
        'deny-private.sh',
        REF,
        '--allow-tcp',
        'host.docker.internal:41234',
        '--hold'
      ])
    ).not.toThrow()
  })
  test.each([
    ['privileged', ['--privileged']],
    ['privileged with a value', ['--privileged=true']],
    ['host network', ['--network', 'host']],
    ['host network by alias', ['--net=host']],
    ['a foreign network', ['--network', 'bridge']],
    ['a foreign container network', ['--network', 'container:postgres']],
    ['a container network of a non-holder', ['--network', 'container:tm-run-o1-1']],
    ['a user network', ['--network', 'tm-host']],
    ['host pid', ['--pid=host']],
    ['a device', ['--device', '/dev/sda']],
    ['an extra capability', ['--cap-add', 'SYS_ADMIN']],
    ['an unconfined seccomp', ['--security-opt', 'seccomp=unconfined']],
    ['root by name', ['--user', 'root']],
    ['a --mount', ['--mount', 'type=bind,src=/,dst=/host']],
    ['a root bind', ['-v', '/:/tm/data']],
    ['a container path outside the allowed ones', ['-v', 'C:\\TM\\data:/host']],
    ['the Docker socket', ['-v', '/var/run/docker.sock:/tm/data']],
    ['a parent-directory source', ['-v', 'C:\\TM\\..\\Users:/tm/data']],
    ['a writable job directory', ['-v', 'C:\\TM\\runs\\r1:/run/tm']],
    ['a writable machine id', ['-v', 'C:\\TM\\m:/etc/machine-id']],
    ['a mount option smuggled into the source', ['-v', 'C:\\TM\\data,bind-propagation=shared:/tm/data']],
    ['a published port on all interfaces', ['-p', '6080:6080']],
    ['a secret in the environment', ['-e', 'OPENAI_API_KEY=sk-x']],
    ['an env file', ['--env-file', 'C:\\x']],
    ['a second name', ['--name', 'tm-run-o9-1']],
    ['a label outside tm.', ['--label', 'com.x=1']],
    ['a label with a newline', ['--label', 'tm.identity=u1\nx']],
    ['a short flag with attached value', ['-v/:/tm/data']],
    ['a pids limit above the server limit', ['--pids-limit', '99999']],
    ['a big shm', ['--shm-size', '64g']],
    ['dns', ['--dns', '10.0.0.1']],
    ['a hostname from outside', ['--hostname', 'evil.example.com']]
  ])('refuses %s', (_, extra) => {
    expect(() => check(workerArgs(extra))).toThrow(UnsafeDockerInput)
  })
  test('refuses a list that is not a run, an unsafe image, or missing hardening', () => {
    const base = workerArgs()
    expect(() => check(['rm', '-f', 'x'])).toThrow(UnsafeDockerInput)
    expect(() => check(base.filter((a) => a !== '--cap-drop' && a !== 'ALL'))).toThrow(UnsafeDockerInput)
    expect(() => check(base.map((a) => (a === 'no-new-privileges' ? 'apparmor=unconfined' : a)))).toThrow(
      UnsafeDockerInput
    )
    expect(() => check(base.map((a) => (a === REF ? 'ghcr.io/evil/worker:1' : a)))).toThrow(UnsafeDockerInput)
    expect(() => check(base.map((a) => (a === REF ? '--privileged' : a)))).toThrow(UnsafeDockerInput)
    expect(() => check(base.slice(0, base.indexOf(REF)))).toThrow(UnsafeDockerInput)
  })
  test('the image prefix needs a / boundary, and every run is judged against it (R15)', () => {
    const evil = 'ghcr.io/tl-evil/worker:1'
    const swap = (ref: string) => workerArgs().map((a) => (a === REF ? ref : a))
    expect(() => check(swap(evil), 'ghcr.io/tl')).toThrow(UnsafeDockerInput)
    expect(() => check(swap(evil), 'ghcr.io/tl/')).toThrow(UnsafeDockerInput)
    expect(() => check(swap(REF), 'ghcr.io/tl')).not.toThrow()
    expect(imageRefOk(evil, 'ghcr.io/tl')).toBe(false)
    expect(imageRefOk(REF, 'ghcr.io/tl')).toBe(true)
    expect(() => check(workerArgs(), '')).toThrow(TypeError)
  })
  test('the error names the kind of problem and never the value', () => {
    let message = ''
    try {
      check(workerArgs(['-e', 'AWS_SECRET=hunter2']))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toBe('Refused to pass an environment variable to docker')
  })
})

describe('bind sources (allowedRoots)', () => {
  const bind = (src: string, roots: readonly string[] = ROOTS) =>
    check(
      workerArgs().map((a) => (a === 'C:\\TM\\data:/tm/data' ? `${src}:/tm/data` : a)),
      PREFIX,
      roots
    )
  test('a folder inside the app tree passes, in either slash, any case, with a drive letter', () => {
    for (const ok of ['C:\\TM\\data', 'C:/TM/data', 'c:\\tm\\DATA', 'C:\\TM', 'C:\\TM\\\\data//x', 'C:\\TM\\a b\\c']) {
      expect(() => bind(ok)).not.toThrow()
    }
  })
  test.each([
    ['/etc'],
    ['/run'],
    ['/var/run'],
    ['/mnt/c/Users'],
    ['/run/desktop/mnt/host/c/Users/x'],
    ['C:\\Users\\x\\.ssh'],
    ['C:\\TMx\\data'],
    ['C:\\TM-evil'],
    ['C:\\'],
    ['/'],
    ['D:\\TM\\data'],
    ['C:\\TM\\..\\Users'],
    ['C:\\TM\\data\\..\\..\\Users'],
    ['C:\\TM/../Users'],
    ['\\\\host\\share\\TM'],
    ['//host/share/TM'],
    ['\\\\?\\C:\\TM\\data'],
    ['\\\\.\\pipe\\docker_engine'],
    ['C:\\TM\\data.'],
    ['C:\\TM\\data::$DATA'],
    ['C:\\TM\\data:stream'],
    ['relative\\TM\\data'],
    ['TM/data'],
    ['C:TM\\data']
  ])('refuses the host path %s', (src) => {
    expect(() => bind(src)).toThrow(UnsafeDockerInput)
  })
  test('a root of the drive, a relative root or no root at all is a configuration error', () => {
    for (const roots of [[], ['C:\\'], ['/'], ['TM'], ['\\\\host\\share']]) {
      expect(() => bind('C:\\TM\\data', roots)).toThrow(TypeError)
      expect(() => cli(fakeSpawn(() => ({})).spawn, { allowedRoots: roots })).toThrow(TypeError)
    }
  })
  test('a posix tree works the same (Linux development)', () => {
    const root = tmpdir()
    expect(normalizeHostPath(`${root}/Local/TolongMeeting/data`)).toBe(
      `${root}/local/tolongmeeting/data`.replaceAll('\\', '/').toLowerCase()
    )
    expect(() => bind(`${root}/Local/data`, [root, ...ROOTS])).not.toThrow()
    expect(() => bind('/etc', [root, ...ROOTS])).toThrow(UnsafeDockerInput)
  })
})

describe('network and capability rules', () => {
  const without = (flag: string) => {
    const args = workerArgs()
    const i = args.indexOf(flag)
    return [...args.slice(0, i), ...args.slice(i + 2)]
  }
  const holder = (over: Record<string, string | null> = {}) => {
    const v = { network: 'tm-local', capAdd: 'NET_ADMIN', user: '0', entrypoint: 'deny-private.sh', ...over }
    return [
      'run',
      '-d',
      '--name',
      'tm-net-o1',
      ...(v.network === null ? [] : ['--network', v.network]),
      ...HARDENING,
      ...(v.capAdd === null ? [] : ['--cap-add', v.capAdd]),
      ...(v.user === null ? [] : ['--user', v.user]),
      ...(v.entrypoint === null ? [] : ['--entrypoint', v.entrypoint]),
      REF,
      '--hold'
    ]
  }
  test('a run without --network (the default bridge) is refused', () => {
    expect(() => check(without('--network'))).toThrow(UnsafeDockerInput)
    expect(() => check(holder({ network: null }))).toThrow(UnsafeDockerInput)
  })
  test.each([
    'bridge',
    'host',
    'default',
    'container:tm-run-o1-1',
    'container:tm-net',
    'container:',
    'tm-x',
    'TM-LOCAL'
  ])('refuses --network %s', (network) => {
    expect(() => check(workerArgs().map((a) => (a === 'container:tm-net-o1' ? network : a)))).toThrow(UnsafeDockerInput)
  })
  test('none, tm-local and container:tm-net-* pass', () => {
    for (const network of ['none', 'container:tm-net-o1', 'container:tm-net-sign_u1']) {
      expect(() => check(workerArgs().map((a) => (a === 'container:tm-net-o1' ? network : a)))).not.toThrow()
    }
  })
  test('a run that joins a holder has no --cap-add', () => {
    expect(() => check(workerArgs(['--cap-add', 'NET_ADMIN']))).toThrow(UnsafeDockerInput)
  })
  test('NET_ADMIN, root and a changed entrypoint pass only together, as the holder', () => {
    expect(() => check(holder())).not.toThrow()
    expect(() => check(holder({ capAdd: null }))).toThrow(UnsafeDockerInput)
    expect(() => check(holder({ user: null }))).toThrow(UnsafeDockerInput)
    expect(() => check(holder({ entrypoint: null }))).toThrow(UnsafeDockerInput)
    expect(() => check(holder({ network: 'none' }))).toThrow(UnsafeDockerInput)
    expect(() => check(holder({ network: 'container:tm-net-o1' }))).toThrow(UnsafeDockerInput)
    expect(() => check(holder({ entrypoint: 'sh' }))).toThrow(UnsafeDockerInput)
    expect(() => check(holder({ user: '0:0' }))).not.toThrow()
    expect(() => check(holder({ user: '00' }))).not.toThrow()
  })
  test('each privilege alone is refused, on any network', () => {
    for (const network of ['none', 'tm-local']) {
      const run = (extra: string[]) => ['run', '--name', 'tm-run-o1', '--network', network, ...HARDENING, ...extra, REF]
      expect(() => check(run([]))).not.toThrow()
      expect(() => check(run(['--cap-add', 'NET_ADMIN']))).toThrow(UnsafeDockerInput)
      expect(() => check(run(['--user', '0']))).toThrow(UnsafeDockerInput)
      expect(() => check(run(['--user', '0:0']))).toThrow(UnsafeDockerInput)
      expect(() => check(run(['--user', '1000:0']))).toThrow(UnsafeDockerInput)
      expect(() => check(run(['--user', '1000']))).not.toThrow()
      expect(() => check(run(['--entrypoint', 'sh']))).toThrow(UnsafeDockerInput)
      expect(() => check(run(['--entrypoint', 'deny-private.sh']))).toThrow(UnsafeDockerInput)
    }
  })
  test('ffmpeg as the entrypoint is allowed only offline and without privileges (the FLAC cut)', () => {
    const run = (network: string, extra: string[] = []) => [
      'run',
      '--name',
      'tm-flac-o1',
      '--network',
      network,
      ...HARDENING,
      ...extra,
      '--entrypoint',
      'ffmpeg',
      REF
    ]
    expect(() => check(run('none'))).not.toThrow()
    expect(() => check(run('tm-local'))).toThrow(UnsafeDockerInput)
    expect(() => check(run('none', ['--cap-add', 'NET_ADMIN']))).toThrow(UnsafeDockerInput)
    expect(() => check(run('none', ['--user', '0']))).toThrow(UnsafeDockerInput)
  })
})

describe('dockerCli with a fake process', () => {
  test('info asks for the memory without a shell and hides the window', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ out: '4100000000\n' }))
    expect(await cli(spawn).info()).toEqual({ memTotal: 4_100_000_000 })
    expect(calls[0]).toMatchObject({
      cmd: DOCKER,
      args: ['info', '--format', '{{json .MemTotal}}'],
      opts: { shell: false, windowsHide: true }
    })
  })
  test('info is null when the daemon is down or docker is not installed, and fails on nonsense', async () => {
    expect(await cli(fakeSpawn(() => ({ code: 1, err: 'Cannot connect' })).spawn).info()).toBeNull()
    const missing = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
    expect(await cli(fakeSpawn(() => ({ throws: missing })).spawn).info()).toBeNull()
    await expect(cli(fakeSpawn(() => ({ out: 'lots' })).spawn).info()).rejects.toBeInstanceOf(DockerError)
  })
  test('pull and image checks refuse an unsafe reference before any process starts', async () => {
    const { spawn, calls } = fakeSpawn(() => ({}))
    const docker = cli(spawn)
    await expect(docker.pull('--privileged')).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.imagePresent('ghcr.io/evil/worker:1')).rejects.toBeInstanceOf(UnsafeDockerInput)
    expect(calls).toHaveLength(0)
    expect(await docker.pull(REF)).toBe(true)
    expect(calls[0]!.args).toEqual(['pull', '--quiet', REF])
  })
  test('pull, image checks and run refuse a repository that only shares the prefix text (R15)', async () => {
    const { spawn, calls } = fakeSpawn(() => ({}))
    const docker = cli(spawn, { imagePrefix: 'ghcr.io/tl' })
    const evil = 'ghcr.io/tl-evil/worker:1'
    await expect(docker.pull(evil)).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.imagePresent(evil)).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.run(workerArgs().map((a) => (a === REF ? evil : a)))).rejects.toBeInstanceOf(UnsafeDockerInput)
    expect(calls).toHaveLength(0)
    expect(await docker.pull(REF)).toBe(true)
  })
  test('docker is started by its absolute path from a folder the user cannot write, never the temp folder', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ out: '1\n' }))
    await cli(spawn).info()
    expect(calls[0]!.cmd).toBe(DOCKER)
    expect(calls[0]!.opts).toMatchObject({ cwd: 'C:\\Program Files\\Docker' })
    expect((calls[0]!.opts as { cwd: string }).cwd).not.toBe(tmpdir())
    const app = fakeSpawn(() => ({ out: '1\n' }))
    await cli(app.spawn, { cwd: '/opt/tolongmeeting' }).info()
    expect(app.calls[0]!.opts).toMatchObject({ cwd: '/opt/tolongmeeting' })
    expect(() => cli(spawn, { dockerPath: 'docker.exe' })).toThrow(TypeError)
    expect(() => cli(spawn, { dockerPath: '.\\docker.exe' })).toThrow(TypeError)
  })
  test('run checks the list first and returns the container id', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ out: 'abc123\n' }))
    const docker = cli(spawn)
    await expect(docker.run(workerArgs(['--privileged']))).rejects.toBeInstanceOf(UnsafeDockerInput)
    expect(calls).toHaveLength(0)
    expect(await docker.run(workerArgs())).toBe('abc123')
    expect(calls[0]!.args).toEqual(workerArgs())
  })
  test("a failed command is told by its exit code; docker's own words never leave", async () => {
    const { spawn } = fakeSpawn(() => ({ code: 125, err: 'invalid mount C:\\Users\\Ana\\secret' }))
    const failure = await cli(spawn)
      .run(workerArgs())
      .then(
        () => null,
        (e: unknown) => e
      )
    expect(failure).toBeInstanceOf(DockerError)
    expect((failure as Error).message).toBe('docker run failed (exit 125)')
    expect(JSON.stringify(failure)).not.toContain('Ana')
  })
  test('names, volumes, networks and timeouts are checked before they reach docker', async () => {
    const { spawn, calls } = fakeSpawn(() => ({}))
    const docker = cli(spawn)
    await expect(docker.rm('x; rm -rf /')).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.wait('--all')).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.stop('tm-run-o1-1', -1)).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.volumeRm('postgres-data')).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.volumes('--all')).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.port('tm-net-o1', 0)).rejects.toBeInstanceOf(UnsafeDockerInput)
    await expect(docker.ensureNetwork('host')).rejects.toBeInstanceOf(UnsafeDockerInput)
    expect(calls).toHaveLength(0)
  })
  test('wait, stop, rm and volume rm use fixed argument lists', async () => {
    const { spawn, calls } = fakeSpawn((args) => (args[0] === 'wait' ? { out: '137\n' } : {}))
    const docker = cli(spawn)
    expect(await docker.wait('tm-run-o1-1')).toBe(137)
    await docker.stop('tm-run-o1-1', 20)
    await docker.rm('tm-net-o1')
    await docker.volumeRm('tm-profile-u1')
    expect(calls.map((c) => c.args)).toEqual([
      ['wait', 'tm-run-o1-1'],
      ['stop', '--time', '20', 'tm-run-o1-1'],
      ['rm', '--force', 'tm-net-o1'],
      ['volume', 'rm', '--force', 'tm-profile-u1']
    ])
  })
  test('stop and rm of a container that is already gone succeed; a live one that will not stop fails', async () => {
    const gone = fakeSpawn((args) => ({ code: 1, err: 'No such container', out: args[0] }))
    await cli(gone.spawn).stop('tm-run-o1-1', 5)
    await cli(gone.spawn).rm('tm-run-o1-1')
    const stuck = fakeSpawn((args) => ({ code: args[0] === 'container' ? 0 : 1 }))
    await expect(cli(stuck.spawn).rm('tm-run-o1-1')).rejects.toBeInstanceOf(DockerError)
  })
  test("running lists this app's containers with the identity label", async () => {
    const { spawn, calls } = fakeSpawn(() => ({
      out: 'tm-signin-u1\tu1\ntm-net-o1\t\ntm-run-o1-1\tu1;rm\ntm-bad name\tu1\n'
    }))
    expect(await cli(spawn).running()).toEqual([
      { name: 'tm-signin-u1', identityId: 'u1' },
      { name: 'tm-net-o1', identityId: null },
      { name: 'tm-run-o1-1', identityId: null }
    ])
    expect(calls[0]!.args).toEqual(['ps', '--filter', 'name=^tm-', '--format', '{{.Names}}\t{{.Label "tm.identity"}}'])
  })
  test('volumes keeps only names that start with the prefix', async () => {
    const { spawn } = fakeSpawn(() => ({ out: 'tm-profile-u1\nold-tm-profile-u2\ntm-profile-u3\n' }))
    expect(await cli(spawn).volumes('tm-profile-')).toEqual(['tm-profile-u1', 'tm-profile-u3'])
  })
  test('port reads the published host port, or null when nothing is published', async () => {
    const some = fakeSpawn(() => ({ out: '127.0.0.1:49153\n' }))
    expect(await cli(some.spawn).port('tm-net-o1', 6080)).toBe(49153)
    expect(some.calls[0]!.args).toEqual(['port', 'tm-net-o1', '6080/tcp'])
    expect(await cli(fakeSpawn(() => ({ code: 1 })).spawn).port('tm-net-o1', 6080)).toBeNull()
  })
  test('ensureNetwork creates the network only when it is missing', async () => {
    const present = fakeSpawn(() => ({}))
    await cli(present.spawn).ensureNetwork('tm-local')
    expect(present.calls.map((c) => c.args[1])).toEqual(['inspect'])
    let made = false
    const missing = fakeSpawn((args) => {
      if (args[1] === 'create') made = true
      return { code: args[1] === 'inspect' && !made ? 1 : 0 }
    })
    await cli(missing.spawn).ensureNetwork('tm-local')
    expect(missing.calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['network', 'inspect'],
      ['network', 'create']
    ])
  })
  test('a command that never ends is killed and reported as a timeout', async () => {
    let killed = false
    const spawn: SpawnLike = () => ({
      exited: new Promise<number>(() => {}),
      stdout: () => '',
      stderrTail: () => '',
      kill: () => (killed = true)
    })
    const original = globalThis.setTimeout
    // Shorten the real 15 s limit of `info` without touching the code under test.
    globalThis.setTimeout = ((fn: () => void) => original(fn, 5)) as unknown as typeof setTimeout
    try {
      expect(await cli(spawn).info()).toBeNull()
    } finally {
      globalThis.setTimeout = original
    }
    expect(killed).toBe(true)
  })
})

describe('findDocker', () => {
  const files = new Set(['/usr/local/bin/docker', 'C:\\Docker\\bin\\docker.exe', '.\\docker.exe', 'docker.exe'])
  const isFile = (p: string) => files.has(p)
  test('takes the first absolute PATH folder that holds docker, and skips relative and empty entries', () => {
    expect(findDocker({ PATH: ':.:bin:/usr/bin:/usr/local/bin' }, 'linux', isFile)).toBe('/usr/local/bin/docker')
    expect(findDocker({ Path: '.;docker;;"C:\\Docker\\bin\\";C:\\Other' }, 'win32', isFile)).toBe(
      'C:\\Docker\\bin\\docker.exe'
    )
    expect(findDocker({ PATH: '.:' }, 'linux', () => true)).toBeNull()
    expect(findDocker({ Path: '.;docker.exe' }, 'win32', () => true)).toBeNull()
    expect(findDocker({}, 'linux', isFile)).toBeNull()
  })
})

// The real daemon on this machine, read-only commands only (nothing is pulled, started or created).
const daemonUp = Bun.spawnSync(['docker', 'info', '--format', '{{json .MemTotal}}']).exitCode === 0
describe.skipIf(!daemonUp)('dockerCli against the real docker', () => {
  const docker = dockerCli(nodeSpawn, { imagePrefix: PREFIX, allowedRoots: ROOTS })
  test('info reports the memory the daemon has', async () => {
    const info = await docker.info()
    expect(info?.memTotal).toBeGreaterThan(0)
  })
  test('an image that is not here is absent, and the read-only listings parse', async () => {
    expect(await docker.imagePresent('ghcr.io/tl/none:0')).toBe(false)
    expect(Array.isArray(await docker.running())).toBe(true)
    expect(Array.isArray(await docker.volumes('tm-profile-'))).toBe(true)
    expect(await docker.port('tm-nonexistent-0', 6080)).toBeNull()
  })
})

describe('logs', () => {
  test('reads the last lines of the container stdout with a plain docker logs', async () => {
    const f = fakeSpawn(() => ({ out: 'one\ndeny-private: ready\n', err: 'ignored' }))
    expect(await cli(f.spawn).logs('tm-net-o1')).toBe('one\ndeny-private: ready\n')
    expect(f.calls.map((c) => c.args)).toEqual([['logs', '--tail', '100', 'tm-net-o1']])
  })

  test('a failing docker logs is a DockerError and a bad name never reaches docker', async () => {
    const f = fakeSpawn(() => ({ code: 1, err: 'No such container' }))
    await expect(cli(f.spawn).logs('tm-net-o1')).rejects.toThrow('docker logs failed (exit 1)')
    await expect(cli(f.spawn).logs('--follow')).rejects.toThrow(UnsafeDockerInput)
    expect(f.calls).toHaveLength(1)
  })
})
