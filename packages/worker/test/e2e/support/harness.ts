import { spawn } from 'node:child_process'
import { format } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tls from 'node:tls'
import type { BrowserContext, Page } from '@playwright/test'
import { parseJob, type JobConfig } from '@tm/core'
import { launchBrowser } from '../../../src/chrome/launch'
import { startScreen } from '../../../src/display/screen'
import { resolveFormLink } from '../../../src/forms/links'
import { startAudioSource } from '../../../src/audio/source'
import { hostnameFor, machineIdFor } from '../../../src/profile/keys'
import { prepareProfile } from '../../../src/profile/profile'
import { startRecorder } from '../../../src/recorder/recorder'
import { runOccurrence, type OccurrenceOutcome, type RunDeps } from '../../../src/run'
import { routeFormFixtures, type FixtureServer } from '../../forms/route'
import { startFakeZoom, type FakeZoom } from './fake-zoom'
import { stageClip } from './media'
import { makePki, type Pki } from './pki'
import {
  MODELS,
  startAiStub,
  startAsrStub,
  startControlStub,
  startNtfyStub,
  type AiStub,
  type AsrStub,
  type ControlStub,
  type NtfyStub
} from './stubs'

const REPO = resolve(import.meta.dirname, '../../../../..')

// The QR decoder's second stage is OpenCV's WeChat detector in a Python process. The repository's spike has a venv
// with the models; an environment that sets these variables (the worker image does) wins.
process.env.TM_WECHAT_PYTHON ??= join(REPO, 'spikes/03-qr/.venv/bin/python')
process.env.TM_WECHAT_MODELS_DIR ??= join(REPO, 'spikes/03-qr/models')

/** The join link the entry holds. Its passcode and the chat's must appear in no ping, file or event. */
export const MEETING_ID = '81234567890'
export const JOIN_PASSCODE = 'SECRETPWD42'
export const CHAT_PASSCODE = 'CHATPWD999'
export const joinLink = `https://e2e.zoom.us/j/${MEETING_ID}?pwd=${JOIN_PASSCODE}`
export const chatJoinLink = `https://e2e.zoom.us/j/${MEETING_ID}?pwd=${CHAT_PASSCODE}`
export const HOST = 'Dr Example (Host)'

const PROFILE_KEY = Buffer.alloc(32, 9)
export const IDENTITY = 'ident-e2e'

export interface Shared {
  pki: Pki
  clip: Buffer
}

// One per process: the ASR stub's certificate is added to this process's trust store once, so every spec file that
// runs in the same worker must use the same certificate.
let shared: Shared | null = null
export function startShared(): Shared {
  if (shared !== null) return shared
  const pki = makePki()
  // The ASR stub's socket is plain TLS with this certificate: only this process learns to trust it.
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pki.cert])
  shared = { pki, clip: stageClip() }
  return shared
}

export interface World {
  root: string
  zoom: FakeZoom
  ntfy: NtfyStub
  ai: AiStub
  asr: AsrStub
  /** The website's heartbeat endpoint; a run uses it only when started with `control: true`. */
  control: ControlStub
  /** Every URL the link resolver asked the (stubbed) network for. */
  fetched: string[]
  /** Short links the stubbed network redirects: address to target. Any other address answers 200. */
  redirects: Map<string, string>
  shared: Shared
  stop(): Promise<void>
}

export async function startWorld(shared: Shared): Promise<World> {
  await mkdir(process.env.TMPDIR ?? tmpdir(), { recursive: true })
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-e2e-'))
  const [zoom, ntfy, ai, asr, control] = await Promise.all([
    startFakeZoom(shared.pki, shared.clip),
    startNtfyStub(),
    startAiStub(),
    startAsrStub(shared.pki),
    startControlStub()
  ])
  return {
    root,
    zoom,
    ntfy,
    ai,
    asr,
    control,
    fetched: [],
    redirects: new Map(),
    shared,
    stop: async () => {
      await Promise.all([zoom.close(), ntfy.close(), ai.close(), asr.close(), control.close()])
    }
  }
}

export interface RunOptions {
  /** Entry times relative to now, in ms. Defaults: starts now, ends in 40 minutes. */
  startInMs?: number
  endInMs?: number
  trustedSenders?: string[]
  /** The entry's link (default: the fixed Zoom link). */
  link?: JobConfig['entry']['link']
  /** The entry's type (default: lecture). Forms are filled in lectures only; mentions are watched in other entries only. */
  type?: JobConfig['entry']['type']
  /** The member's `mentionNames`. */
  mentionNames?: string[]
  /** A restart of the same occurrence: the attempt number (default 1). */
  attempt?: number
  /** A restart in a fresh container: the working profile is removed first, so the checkpoint restores it. */
  freshProfile?: boolean
  /** The job carries the control channel (the world's stub); the heartbeat goes every `heartbeatMs` (default 1 s). */
  control?: boolean
  heartbeatMs?: number
  /** Called when the browser is up and the form fixtures are routed, before the worker opens anything. */
  onBrowser?: (run: Running) => void | Promise<void>
}

export interface Running {
  cfg: JobConfig
  dataDir: string
  profileRoot: string
  outcome: Promise<OccurrenceOutcome>
  /** Resolves with the time the run ended (set when `outcome` settles). */
  endedAt(): number | null
  abort(): void
  abortedAt(): number | null
  fx: FixtureServer
  context: BrowserContext
  stage: Page
  desk: Page
  /** Form-provider POSTs the browser sent, and requests to look-alike hosts. */
  posts: { provider: 'google' | 'microsoft'; url: string }[]
  decoyRequests: string[]
  events(): Promise<WorkerEvent[]>
  /** Everything the run wrote with console.log, info, warn and error. */
  logs: string[]
}

export interface WorkerEvent {
  type: string
  at: string
  data: Record<string, unknown>
}

export const jobFor = (world: World, o: RunOptions, dataDir: string, profileDir: string): JobConfig => {
  const now = Date.now()
  return parseJob({
    occurrenceId: 'occ-e2e',
    attempt: o.attempt ?? 1,
    entry: {
      name: 'Data Mining',
      type: o.type ?? 'lecture',
      start: new Date(now + (o.startInMs ?? 0)).toISOString(),
      end: new Date(now + (o.endInMs ?? 40 * 60_000)).toISOString(),
      timeZone: 'Asia/Kuala_Lumpur',
      link: o.link ?? { kind: 'fixed', url: joinLink },
      trustedSenders: o.trustedSenders ?? [],
      transcription: 'live',
      formDetails: { course_code: 'ABC1234', section: '02', lecturer: 'Dr Example' },
      attendanceKeywords: []
    },
    identity: {
      id: IDENTITY,
      name: 'University',
      zoomGuestName: 'Test Student',
      formProviders: ['google', 'microsoft'],
      organisation: { name: 'Example University', emailDomain: 'example.edu.my' }
    },
    member: {
      id: 'member-e2e',
      displayName: 'Test Student',
      mentionNames: o.mentionNames ?? [],
      details: [
        { key: 'full_name', value: 'Test Student', labels: [] },
        { key: 'student_id', value: 'A00000000', labels: [] },
        { key: 'university_email', value: 'student@example.edu.my', labels: [] },
        { key: 'programme', value: 'MSc Example', labels: [] }
      ]
    },
    ai: { baseUrl: world.ai.url, apiKey: 'sk-e2e-key', asrUrl: world.asr.url, models: MODELS },
    ntfy: { url: world.ntfy.url, topic: 'e2e-topic', token: 'tk-e2e-token' },
    dataDir,
    profileDir,
    control: o.control === true ? { url: world.control.url, token: world.control.token } : null
  })
}

const FORM_POST =
  /^https:\/\/docs\.google\.com\/forms\/d\/e\/[^/]+\/formResponse$|^https:\/\/forms\.office\.com\/formapi\//
const DECOY_HOST = /(^|\.)evil\.test$/

// Starts `runOccurrence` on the real components. Only these are replaced, each by the same function with the option the
// code reserves for tests, or by the same function pointed at a local server: the virtual screen without a window
// manager (the host has none), the audio source and the recorder's sound from generated signals (the host has no
// PulseAudio), the host check of the profile (the machine is not the identity's host), Chrome with extra flags that
// send *.zoom.us to the fake Zoom, and the link resolver with a fetch that never leaves the machine.
export function startWorker(world: World, options: RunOptions = {}): Running {
  const dataDir = join(world.root, 'occurrences', 'occ-e2e')
  const profileDir = join(world.root, 'profiles', IDENTITY, 'work')
  const profileRoot = join(world.root, 'profiles')
  const cfg = jobFor(world, options, dataDir, profileDir)
  const abort = new AbortController()
  let abortedAt: number | null = null
  let endedAt: number | null = null
  const running = {
    cfg,
    dataDir,
    profileRoot,
    posts: [],
    decoyRequests: [],
    logs: [],
    abort: () => {
      abortedAt ??= Date.now()
      abort.abort()
    },
    abortedAt: () => abortedAt,
    endedAt: () => endedAt,
    events: () => readEvents(dataDir)
  } as unknown as Running

  process.env.TM_PROFILE_ROOT = profileRoot
  const machineIdPath = join(world.root, 'machine-id')
  const port = world.zoom.port
  const chromeFlags = [
    `--host-resolver-rules=MAP *.zoom.us 127.0.0.1:${port}, MAP zoom.us 127.0.0.1:${port}, MAP * ~NOTFOUND`,
    `--ignore-certificate-errors-spki-list=${world.shared.pki.spki}`
  ]

  const deps: Partial<RunDeps> = {
    signal: abort.signal,
    heartbeat: { intervalMs: options.heartbeatMs ?? 1_000 },
    loadProfileKey: () => PROFILE_KEY,
    prepareProfile: (dir, id) => prepareProfile(dir, id, { hostname: hostnameFor(id), machineIdPath }),
    startScreen: () => startScreen({ windowManager: 'none' }),
    startAudioSource: () => startAudioSource({ testInput: 'sine' }),
    startRecorder: (screen, dir, attempt) =>
      startRecorder(screen, dir, attempt, { segmentSeconds: 20, testAudio: 'silence' }),
    launchBrowser: async (dir, screen) => {
      const browser = await launchBrowser(dir, screen, chromeFlags)
      running.context = browser.context
      running.stage = browser.stage
      running.desk = browser.desk
      running.fx = await routeFormFixtures(browser.context)
      // Added after the fixtures' routes, so it sees each request first and hands it on.
      await browser.context.route(
        (url) => FORM_POST.test(url.href) || DECOY_HOST.test(url.hostname),
        async (route) => {
          const request = route.request()
          const url = request.url()
          if (DECOY_HOST.test(new URL(url).hostname)) running.decoyRequests.push(url)
          else if (request.method() === 'POST')
            running.posts.push({ provider: url.includes('google') ? 'google' : 'microsoft', url })
          await route.fallback()
        }
      )
      await options.onBrowser?.(running)
      return browser
    },
    resolveFormLink: (c) =>
      resolveFormLink(c, {
        fetch: (async (input: Request | string | URL) => {
          world.fetched.push(String(input))
          const target = world.redirects.get(String(input))
          return target === undefined
            ? new Response(null, { status: 200 })
            : new Response(null, { status: 302, headers: { location: target } })
        }) as typeof fetch
      })
  }

  const prepared = (async () => {
    if (options.freshProfile === true) await rm(profileDir, { recursive: true, force: true })
    await mkdir(dataDir, { recursive: true })
    await writeFile(machineIdPath, `${machineIdFor(IDENTITY)}\n`)
  })()
  // The run's console output is kept for the secret search; it still reaches the terminal.
  const methods = ['log', 'info', 'warn', 'error'] as const
  const originals = methods.map((m) => console[m])
  methods.forEach((m, i) => {
    console[m] = (...args: unknown[]) => {
      running.logs.push(format(...args))
      originals[i]!(...args)
    }
  })
  running.outcome = prepared
    .then(() => runOccurrence(cfg, deps))
    .finally(() => {
      endedAt = Date.now()
      methods.forEach((m, i) => (console[m] = originals[i]!))
    })
  return running
}

export async function readEvents(dataDir: string): Promise<WorkerEvent[]> {
  let text: string
  try {
    text = await readFile(join(dataDir, 'events.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as WorkerEvent)
}

export async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => T | Promise<T>,
  stillWanted: () => boolean = () => true
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value as NonNullable<T>
    if (!stillWanted()) throw new Error(`gave up waiting for ${what}: the run ended first`)
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Resolves true once the worker run has settled. */
export const finished =
  (run: Running): (() => boolean) =>
  () =>
    run.endedAt() === null

// Every file below `dir`, relative, skipping what is binary or huge.
export async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)))
    else out.push(rel)
  }
  return out
}

const TEXT_FILE = /\.(md|json|jsonl|yml|txt|log)$/

// The text of every text file in the occurrence directory, by relative path.
export async function textFiles(dataDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const rel of await listFiles(dataDir)) {
    if (TEXT_FILE.test(rel)) files.set(rel, await readFile(join(dataDir, rel), 'utf8'))
  }
  return files
}

export async function runPipelineCli(
  world: World,
  cfg: JobConfig
): Promise<{ code: number | null; stderr: string; ms: number }> {
  const file = join(world.root, 'pipeline-job.json')
  await writeFile(file, JSON.stringify(cfg))
  const started = Date.now()
  const child = spawn('bun', [join(REPO, 'packages/pipeline/src/cli.ts'), '--job', file], {
    env: { ...process.env, TMPDIR: process.env.TMPDIR ?? tmpdir() },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
  const code = await new Promise<number | null>((done) => child.once('close', done))
  return { code, stderr, ms: Date.now() - started }
}

export async function keepOrRemove(world: World, failed: boolean): Promise<void> {
  const keep = failed || process.env.TM_E2E_KEEP === '1'
  if (keep) console.error(`[e2e] kept ${world.root}`)
  else await rm(world.root, { recursive: true, force: true })
}

export const exists = existsSync
