import { statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path'
import type { SpawnLike } from '../jobs/whisper'

// The only code that starts `docker` on the member's PC. Every call is an argv array through `SpawnLike` (no shell,
// `windowsHide`). Image references, container and volume names, labels, mounts and environment names are checked
// against fixed patterns first, so nothing a server or a member typed can add a flag. `run` takes a whole argument
// list and refuses any flag outside a short allow-list (see `checkRunArgs`). Docker's own error text never leaves this
// file: a failure is a `DockerError` that carries the operation and the exit code.

export interface DockerLike {
  info(): Promise<{ memTotal: number } | null> // null when the daemon isn't reachable
  imagePresent(ref: string): Promise<boolean>
  pull(ref: string): Promise<boolean>
  run(args: string[]): Promise<string> // the whole argument list, starting with 'run'; resolves stdout once docker exits (the container id with -d)
  wait(name: string): Promise<number> // exit code
  logs(name: string): Promise<string> // the last lines the container wrote to its stdout (not its stderr)
  stop(name: string, timeoutSec: number): Promise<void>
  rm(name: string): Promise<void>
  volumeRm(name: string): Promise<void>
  volumes(prefix: string): Promise<string[]>
  running(): Promise<{ name: string; identityId: string | null }[]> // from the label tm.identity
  port(name: string, containerPort: number): Promise<number | null> // published host port
  ensureNetwork(name: string): Promise<void>
}

/** A docker command failed. The message holds the operation and the exit code, never Docker's own words. */
export class DockerError extends Error {
  constructor(
    readonly op: string,
    readonly kind: 'exit' | 'timeout' | 'missing' | 'output',
    readonly code: number | null = null
  ) {
    super(
      kind === 'exit'
        ? `docker ${op} failed (exit ${code})`
        : kind === 'timeout'
          ? `docker ${op} timed out`
          : kind === 'missing'
            ? 'The docker program was not found'
            : `docker ${op} answered something unexpected`
    )
    this.name = 'DockerError'
  }
}

/** Something that must never reach docker: a bad image reference, name, or `run` flag. The message names no value. */
export class UnsafeDockerInput extends Error {
  constructor(what: string) {
    super(`Refused to pass ${what} to docker`)
    this.name = 'UnsafeDockerInput'
  }
}

// --- Validation ---

const HOST = String.raw`(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9]+(?:[.-][a-z0-9]+)*|[a-z0-9]+(?:[.-][a-z0-9]+)*:[0-9]{1,5})(?::[0-9]{1,5})?`
const PATH = String.raw`[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*`
const IMAGE_BY_DIGEST = new RegExp(`^${HOST}/${PATH}@sha256:[0-9a-f]{64}$`)
const IMAGE_BY_TAG = new RegExp(`^${HOST}/${PATH}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
const IMAGE_MAX = 300

/** The prefix with a `/` at its end, so `ghcr.io/tolonglabs` never matches `ghcr.io/tolonglabs-evil/x`. */
export function imagePrefixBoundary(prefix: string): string {
  const bounded = prefix.endsWith('/') ? prefix : `${prefix}/`
  if (!/^[a-z0-9][a-z0-9._:/-]*\/$/.test(bounded)) throw new TypeError('The image prefix is not a repository path')
  return bounded
}

/**
 * `registry/name@sha256:<64 hex>` or `registry/name:<exact tag>`, nothing else: the registry is explicit (a dot, a port
 * or `localhost`), and the text starts with a letter or digit, so it can never be read as a flag. With `prefix`, the
 * reference must also start with it, on a `/` boundary (the repository the app was built to trust).
 */
export function imageRefOk(ref: string, prefix?: string): boolean {
  if (ref.length > IMAGE_MAX || !(IMAGE_BY_DIGEST.test(ref) || IMAGE_BY_TAG.test(ref))) return false
  return prefix === undefined || ref.startsWith(imagePrefixBoundary(prefix))
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
/** `tm-<kind>-<id>`: the shape of every container, volume and network this app makes. Ids come from `ID`. */
const RESOURCE = /^tm-[a-z]{2,12}-[A-Za-z0-9_-]{1,80}$/
const NETWORK = /^tm-[a-z0-9-]{1,40}$/
const LABEL_KEY = /^tm\.[a-z][a-z0-9.]{0,30}$/
const LABEL_VALUE = /^[A-Za-z0-9_.-]{1,64}$/

export const resourceNameOk = (name: string): boolean => RESOURCE.test(name)

function assertResource(name: string, what: string): void {
  if (!RESOURCE.test(name)) throw new UnsafeDockerInput(what)
}

// `docker run` flags. `once` flags may appear once. A value check throws on a value it does not allow.
const CONTAINER_PATH =
  /^(?:\/tm\/data|\/run\/tm|\/etc\/machine-id|\/tm\/profiles\/[A-Za-z0-9_-]{1,64}\/(?:vol|work|checkpoints))$/
const READ_ONLY_PATHS = new Set(['/run/tm', '/etc/machine-id'])
const BYTES = { m: 1024 ** 2, g: 1024 ** 3 } as const
const MAX_SHM_BYTES = 2 * BYTES.g
const MAX_MEMORY_BYTES = 5 * BYTES.g
const MAX_CPUS = 4
const MAX_PIDS = 2048
const MAX_VOLUMES = 8
const MAX_TAIL_WORDS = 20
const MAX_TAIL_CHARS = 1000
const MAX_ENV_VALUE = 2000

function size(value: string, max: number, what: string): void {
  const m = /^([1-9][0-9]{0,6})([mg])$/.exec(value)
  if (!m || Number(m[1]) * BYTES[m[2] as 'm' | 'g'] > max) throw new UnsafeDockerInput(what)
}

/**
 * A plain absolute host path in one comparable form: forward slashes, no repeated slashes, lower case (a Windows path
 * has no case), the drive letter kept. `null` for a UNC or device path (`\\host\share`, `\\?\`, `\\.\pipe`), a relative
 * path, a `.` or `..` part, a part that Windows would read as another name (a trailing dot or space), a stream (`:`),
 * a control character or a character docker reads as a mount option.
 */
export function normalizeHostPath(src: string): string | null {
  if (/[\p{Cc},"*?<>|]/u.test(src)) return null
  const flat = src.replaceAll('\\', '/')
  if (flat.startsWith('//')) return null
  const drive = /^([A-Za-z]):(\/.*)$/.exec(flat)
  const rest = drive ? drive[2]! : flat
  if (!drive && !flat.startsWith('/')) return null
  if (rest.includes(':')) return null
  const parts = rest.split('/').filter((part) => part !== '')
  if (parts.some((part) => part === '.' || part === '..' || /[. ]$/.test(part))) return null
  if (/docker\.sock|\.pipe/i.test(flat)) return null
  return `${drive ? `${drive[1]!.toLowerCase()}:` : ''}/${parts.join('/')}`.toLowerCase()
}

function normalizedRoots(allowedRoots: readonly string[]): string[] {
  const roots = allowedRoots.map((root) => normalizeHostPath(root))
  // A root of `/` or `C:\` would allow every path on the drive.
  if (roots.length === 0 || roots.some((r) => r === null || /^(?:[a-z]:)?\/$/.test(r))) {
    throw new TypeError('allowedRoots must be absolute folders below the drive root')
  }
  return roots as string[]
}

function volume(value: string, roots: readonly string[]): void {
  let spec = value
  const readOnly = spec.endsWith(':ro')
  if (readOnly) spec = spec.slice(0, -3)
  const cut = spec.lastIndexOf(':')
  const src = spec.slice(0, cut)
  const dest = spec.slice(cut + 1)
  if (cut < 1 || !CONTAINER_PATH.test(dest)) throw new UnsafeDockerInput('a mount')
  if (!RESOURCE.test(src)) {
    const path = normalizeHostPath(src)
    if (path === null || !roots.some((root) => path === root || path.startsWith(`${root}/`))) {
      throw new UnsafeDockerInput('a mount')
    }
  }
  if (READ_ONLY_PATHS.has(dest) && !readOnly) throw new UnsafeDockerInput('a writable mount')
}

type Rule = { value: false } | { value: true; once?: boolean; check: (v: string, roots: readonly string[]) => void }
const flag: Rule = { value: false }
const rule = (check: Extract<Rule, { value: true }>['check'], once = true): Rule => ({ value: true, once, check })
const exactly =
  (...allowed: string[]) =>
  (v: string) => {
    if (!allowed.includes(v)) throw new UnsafeDockerInput('a flag value')
  }
const matching = (re: RegExp, what: string) => (v: string) => {
  if (!re.test(v)) throw new UnsafeDockerInput(what)
}

const RULES: Record<string, Rule> = {
  '-d': flag,
  '--detach': flag,
  '--rm': flag,
  '--name': rule((v) => assertResource(v, 'a container name')),
  '--label': rule((v) => {
    const eq = v.indexOf('=')
    if (eq < 1 || !LABEL_KEY.test(v.slice(0, eq)) || !LABEL_VALUE.test(v.slice(eq + 1))) {
      throw new UnsafeDockerInput('a label')
    }
  }, false),
  '--hostname': rule(matching(/^tm-[A-Za-z0-9_-]{1,20}$/, 'a host name')),
  // No network, the app's own network (the holder), or the namespace of a holder `tm-net-*`. Never the default bridge.
  '--network': rule(matching(/^(?:none|tm-local|container:tm-net-[A-Za-z0-9_-]{1,80})$/, 'a network')),
  '--cap-drop': rule(exactly('ALL'), false),
  '--cap-add': rule(exactly('NET_ADMIN'), false),
  '--security-opt': rule(exactly('no-new-privileges', 'no-new-privileges=true', 'no-new-privileges:true'), false),
  '--shm-size': rule((v) => size(v, MAX_SHM_BYTES, 'a shared-memory size')),
  '--memory': rule((v) => size(v, MAX_MEMORY_BYTES, 'a memory limit')),
  '--cpus': rule((v) => {
    if (!/^[0-9](?:\.[0-9]{1,2})?$/.test(v) || Number(v) <= 0 || Number(v) > MAX_CPUS) {
      throw new UnsafeDockerInput('a CPU limit')
    }
  }),
  '--pids-limit': rule((v) => {
    if (!/^[1-9][0-9]{0,4}$/.test(v) || Number(v) > MAX_PIDS) throw new UnsafeDockerInput('a process limit')
  }),
  '--user': rule(matching(/^[0-9]{1,5}(?::[0-9]{1,5})?$/, 'a user')),
  '--sysctl': rule(exactly('net.ipv6.conf.all.disable_ipv6=1'), false),
  '--entrypoint': rule(matching(/^[a-z][a-z0-9._-]{0,60}$/, 'an entrypoint')),
  '--pull': rule(exactly('never')),
  '-p': rule(matching(/^127\.0\.0\.1::[0-9]{1,5}$/, 'a published port'), false),
  '-v': rule((v, roots) => volume(v, roots), false),
  '-e': rule((v) => {
    const eq = v.indexOf('=')
    if (eq < 1 || !/^TM_[A-Z0-9_]{1,60}$/.test(v.slice(0, eq)) || v.length - eq > MAX_ENV_VALUE) {
      throw new UnsafeDockerInput('an environment variable')
    }
    if (/[\p{Cc}]/u.test(v)) throw new UnsafeDockerInput('an environment variable')
  }, false)
}
const ALIASES: Record<string, string> = {
  '--volume': '-v',
  '--publish': '-p',
  '--env': '-e',
  '--net': '--network',
  '-l': '--label',
  '-m': '--memory',
  '-u': '--user'
}

/** The holder: root with `NET_ADMIN`, running the egress script, on the app's own network. */
const HOLDER_ENTRYPOINT = 'deny-private.sh'
/** The FLAC cut: the image's ffmpeg, with no network at all. */
const FLAC_ENTRYPOINT = 'ffmpeg'

/**
 * Checks a whole `docker run` argument list. Only the flags in `RULES` pass, each with a value of the expected shape;
 * there is no `--privileged`, no `--mount`, no host network or PID namespace, no device, and no bind mount outside
 * `allowedRoots` (the app's own folder, compared without case after `\` and `/` are unified; a UNC or device path
 * never passes). The image must start with `imagePrefix` on a `/` boundary. The hardening is required: `--cap-drop
 * ALL`, `--security-opt no-new-privileges`, `--name`, a `--pids-limit`, and a `--network` of `none`, `tm-local` or
 * `container:tm-net-*`. `--cap-add NET_ADMIN`, root and an entrypoint other than the image's own are allowed only as
 * the holder (all three, `deny-private.sh`, on `tm-local`), except `--entrypoint ffmpeg` on `--network none`. A run
 * that joins a holder's network adds no capability. After the image come the container's own words, which docker never
 * reads as flags. Throws an `UnsafeDockerInput` that names the kind of problem and no value.
 */
export function checkRunArgs(args: string[], imagePrefix: string, allowedRoots: readonly string[]): void {
  const roots = normalizedRoots(allowedRoots)
  if (args[0] !== 'run') throw new UnsafeDockerInput('anything but a run command')
  if (args.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new UnsafeDockerInput('a bad argument')
  const seen = new Map<string, string[]>()
  let i = 1
  for (; i < args.length && args[i]!.startsWith('-'); i++) {
    const token = args[i]!
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const given = eq === -1 ? token : token.slice(0, eq)
    const name = ALIASES[given] ?? given
    const r = Object.hasOwn(RULES, name) ? RULES[name]! : undefined
    if (r === undefined) throw new UnsafeDockerInput('a flag that is not allowed')
    if (!r.value) {
      if (eq !== -1) throw new UnsafeDockerInput('a flag value')
      seen.set(name, [])
      continue
    }
    const value = eq === -1 ? args[++i] : token.slice(eq + 1)
    if (value === undefined) throw new UnsafeDockerInput('a flag without a value')
    if (r.once && seen.has(name)) throw new UnsafeDockerInput('a repeated flag')
    r.check(value, roots)
    seen.set(name, [...(seen.get(name) ?? []), value])
  }
  const image = args[i]
  if (image === undefined || !imageRefOk(image, imagePrefix)) throw new UnsafeDockerInput('an image reference')
  const tail = args.slice(i + 1)
  if (tail.length > MAX_TAIL_WORDS || tail.join(' ').length > MAX_TAIL_CHARS) throw new UnsafeDockerInput('a command')
  const volumes = seen.get('-v')?.length ?? 0
  if (volumes > MAX_VOLUMES) throw new UnsafeDockerInput('too many mounts')
  const need = (name: string, ok: (values: string[]) => boolean) => {
    if (!ok(seen.get(name) ?? [])) throw new UnsafeDockerInput('a run command without its required hardening')
  }
  need('--name', (v) => v.length === 1)
  need('--cap-drop', (v) => v.includes('ALL'))
  need('--security-opt', (v) => v.length > 0)
  need('--pids-limit', (v) => v.length === 1)
  need('--network', (v) => v.length === 1)

  const network = seen.get('--network')![0]!
  const capAdd = seen.get('--cap-add') ?? []
  const user = seen.get('--user')?.[0]
  const entrypoint = seen.get('--entrypoint')?.[0]
  const root = user !== undefined && user.split(':').some((id) => Number(id) === 0)
  const holder =
    capAdd.length === 1 &&
    capAdd[0] === 'NET_ADMIN' &&
    root &&
    entrypoint === HOLDER_ENTRYPOINT &&
    network === 'tm-local'
  const flac = entrypoint === FLAC_ENTRYPOINT && network === 'none' && capAdd.length === 0 && !root
  if ((capAdd.length > 0 || root || entrypoint === HOLDER_ENTRYPOINT) && !holder) {
    throw new UnsafeDockerInput('privileges outside the network holder')
  }
  if (entrypoint !== undefined && !holder && !flac) throw new UnsafeDockerInput('an entrypoint')
  if (network.startsWith('container:') && capAdd.length > 0) throw new UnsafeDockerInput('a capability')
}

// --- The CLI driver ---

const SHORT_MS = 60_000
const INFO_MS = 15_000
const PULL_MS = 30 * 60_000
const INTEGER = /^[0-9]{1,16}$/
/** `docker logs --tail`: the reader never takes more than this many lines (the caller's spawn also caps the bytes). */
const LOGS_TAIL_LINES = 100

export interface DockerCliOptions {
  /** Refuse any image outside this repository (the app's `TM_WORKER_IMAGE_PREFIX`), matched on a `/` boundary. */
  imagePrefix: string
  /** The only host folders a `run` may bind: the app's `%LOCALAPPDATA%\\TolongMeeting` tree (`localPaths(...).root`). */
  allowedRoots: readonly string[]
  /** The absolute path of the docker program. Default: the first `docker` found on PATH (`findDocker`), looked up once. */
  dockerPath?: string
  /**
   * Where docker starts. It must be a folder this user cannot write to, since Windows looks for programs in the
   * current folder. Default: the folder of the docker program, else the folder of the app itself.
   */
  cwd?: string
}

/**
 * The absolute path of the first `docker` (`docker.exe` on Windows) in the folders of `PATH`, or `null`. A relative or
 * empty `PATH` entry is skipped, so the current folder is never searched.
 */
export function findDocker(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = (p) => {
    try {
      return statSync(p).isFile()
    } catch (e) {
      if (e instanceof Error && 'code' in e && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(e.code))) return false
      throw e
    }
  }
): string | null {
  const win = platform === 'win32'
  const path = (win ? (env.Path ?? env.PATH) : env.PATH) ?? ''
  const dockerIn = win
    ? (dir: string) => `${dir.replace(/[\\/]+$/, '')}\\docker.exe`
    : (dir: string) => join(dir, 'docker')
  for (const dir of path.split(win ? ';' : delimiter)) {
    const clean = dir.replace(/^"|"$/g, '')
    if (clean === '' || !(win ? /^[A-Za-z]:[\\/]/.test(clean) : isAbsolute(clean))) continue
    const candidate = dockerIn(clean)
    if (isFile(candidate)) return candidate
  }
  return null
}

export function dockerCli(spawn: SpawnLike, options: DockerCliOptions): DockerLike {
  const prefix = imagePrefixBoundary(options.imagePrefix)
  const roots = options.allowedRoots
  normalizedRoots(roots) // a bad root fails here, at start, not at the first run
  const docker = options.dockerPath ?? findDocker() ?? 'docker'
  if (docker !== 'docker' && !isAbsolute(docker) && !/^[A-Za-z]:[\\/]/.test(docker)) {
    throw new TypeError('dockerPath must be an absolute path')
  }
  const windowsPath = /^[A-Za-z]:[\\/]/.test(docker)
  const cwd =
    options.cwd ??
    (docker === 'docker' ? dirname(process.execPath) : (windowsPath ? win32 : { dirname }).dirname(docker))

  async function exec(op: string, args: string[], timeoutMs: number | null): Promise<{ code: number; out: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const proc = spawn(docker, args, { cwd, shell: false, windowsHide: true })
      const timedOut =
        timeoutMs === null
          ? []
          : [new Promise<'timeout'>((res) => (timer = setTimeout(() => res('timeout'), timeoutMs)))]
      const code = await Promise.race([proc.exited, ...timedOut])
      if (code === 'timeout') {
        proc.kill()
        throw new DockerError(op, 'timeout')
      }
      return { code, out: proc.stdout() }
    } catch (e) {
      if (e instanceof Error && 'code' in e && (e.code === 'ENOENT' || e.code === 'EACCES')) {
        throw new DockerError(op, 'missing')
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  async function ok(op: string, args: string[], timeoutMs: number | null = SHORT_MS): Promise<string> {
    const r = await exec(op, args, timeoutMs)
    if (r.code !== 0) throw new DockerError(op, 'exit', r.code)
    return r.out
  }

  const image = (ref: string): string => {
    if (!imageRefOk(ref, prefix)) throw new UnsafeDockerInput('an image reference')
    return ref
  }
  const lines = (out: string): string[] =>
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')
  const integer = (op: string, out: string): number => {
    const text = out.trim()
    if (!INTEGER.test(text)) throw new DockerError(op, 'output')
    return Number(text)
  }
  /** True when `docker container inspect` finds the container. Used to tell "already gone" from a real failure. */
  const exists = async (name: string): Promise<boolean> =>
    (await exec('inspect', ['container', 'inspect', '--format', '{{.Id}}', name], SHORT_MS)).code === 0

  return {
    async info() {
      let r: { code: number; out: string }
      try {
        r = await exec('info', ['info', '--format', '{{json .MemTotal}}'], INFO_MS)
      } catch (e) {
        if (e instanceof DockerError && e.kind !== 'output') return null
        throw e
      }
      if (r.code !== 0) return null
      return { memTotal: integer('info', r.out) }
    },

    async imagePresent(ref) {
      return (await exec('image inspect', ['image', 'inspect', '--format', '{{.Id}}', image(ref)], SHORT_MS)).code === 0
    },

    async pull(ref) {
      return (await exec('pull', ['pull', '--quiet', image(ref)], PULL_MS)).code === 0
    },

    async run(args) {
      checkRunArgs(args, prefix, roots)
      return (await ok('run', args, SHORT_MS)).trim()
    },

    async wait(name) {
      assertResource(name, 'a container name')
      return integer('wait', await ok('wait', ['wait', name], null))
    },

    async logs(name) {
      assertResource(name, 'a container name')
      // `docker logs` writes the container's stdout to its stdout and the container's stderr to its stderr; only the
      // first is read (`SpawnLike.stdout()`), so a line counts only if the container's process wrote it to stdout.
      return ok('logs', ['logs', '--tail', String(LOGS_TAIL_LINES), name])
    },

    async stop(name, timeoutSec) {
      assertResource(name, 'a container name')
      if (!Number.isInteger(timeoutSec) || timeoutSec < 0 || timeoutSec > 600) throw new UnsafeDockerInput('a timeout')
      const r = await exec('stop', ['stop', '--time', String(timeoutSec), name], SHORT_MS + timeoutSec * 1000)
      if (r.code !== 0 && (await exists(name))) throw new DockerError('stop', 'exit', r.code)
    },

    async rm(name) {
      assertResource(name, 'a container name')
      const r = await exec('rm', ['rm', '--force', name], SHORT_MS)
      if (r.code !== 0 && (await exists(name))) throw new DockerError('rm', 'exit', r.code)
    },

    async volumeRm(name) {
      assertResource(name, 'a volume name')
      // `--force` makes a volume that is already gone a success; a volume still in use fails.
      await ok('volume rm', ['volume', 'rm', '--force', name])
    },

    async volumes(volumePrefix) {
      if (!/^tm-[a-z]{2,12}-[A-Za-z0-9_-]{0,80}$/.test(volumePrefix)) throw new UnsafeDockerInput('a volume prefix')
      const out = await ok('volume ls', ['volume', 'ls', '--quiet', '--filter', `name=${volumePrefix}`])
      // The name filter matches anywhere in the name; keep only names that start with the prefix.
      return lines(out).filter((n) => n.startsWith(volumePrefix) && RESOURCE.test(n))
    },

    async running() {
      const out = await ok('ps', ['ps', '--filter', 'name=^tm-', '--format', '{{.Names}}\t{{.Label "tm.identity"}}'])
      const found: { name: string; identityId: string | null }[] = []
      for (const line of lines(out)) {
        const [name = '', label = ''] = line.split('\t')
        if (!RESOURCE.test(name)) continue
        found.push({ name, identityId: ID.test(label) ? label : null })
      }
      return found
    },

    async port(name, containerPort) {
      assertResource(name, 'a container name')
      if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
        throw new UnsafeDockerInput('a port')
      }
      const r = await exec('port', ['port', name, `${containerPort}/tcp`], SHORT_MS)
      if (r.code !== 0) return null
      // Lines look like `127.0.0.1:49153` or `[::]:49153`.
      const m = /:([0-9]{1,5})$/.exec(lines(r.out)[0] ?? '')
      const host = m ? Number(m[1]) : 0
      return host >= 1 && host <= 65535 ? host : null
    },

    async ensureNetwork(name) {
      if (!NETWORK.test(name)) throw new UnsafeDockerInput('a network name')
      const present = async () =>
        (await exec('network inspect', ['network', 'inspect', '--format', '{{.Id}}', name], SHORT_MS)).code === 0
      if (await present()) return
      const r = await exec('network create', ['network', 'create', name], SHORT_MS)
      // Another start may have made it between the two calls.
      if (r.code !== 0 && !(await present())) throw new DockerError('network create', 'exit', r.code)
    }
  }
}
