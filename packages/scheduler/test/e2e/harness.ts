// Harness for the end-to-end server flow test (../e2e-flow.test.ts).
//
// Real: Postgres, pg-boss, the Next route functions (called with Request objects), Better Auth sessions, ffmpeg, sharp,
// the scheduler (launch, monitor, retention) and the pipeline consumer. Fake: Docker (FakeDocker), ntfy (a Bun.serve
// stub plus a fake admin API), the AI provider (a Bun.serve stub), GitHub (never called) and the key tester.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { JobConfigSchema, localParts, type JobConfig, type OccurrenceState, type SpecEnv } from '@tm/core'
import { sampleRecord } from '@tm/core/testing'
import { eq, sql } from 'drizzle-orm'
import { closeDb, members, occurrences, schema, type Db } from '@tm/web/db'
import { DEFAULT_MODELS } from '@tm/web/db/job-config'
import { memberNotifier, type Notifier } from '@tm/web/db/notifier'
import { bossQueue, QUEUES, type Queue } from '@tm/web/db/queues'
import { createTestDb, dropAllTestDbs, seedAuthUser, testDbUrl } from '@tm/web/db/testing'
import { saveAiKeys, type KeyTester } from '@tm/web/lib/ai-keys'
import { authSecret } from '@tm/web/lib/auth-secret'
import { createIdentity } from '@tm/web/lib/identities'
import { ensureNtfy, type NtfyAdmin } from '@tm/web/lib/ntfy-admin'
import { createScope, type MemberScope } from '@tm/web/lib/scope'
import { saveEntry, type EntryDeps } from '@tm/web/lib/timetable'
// pg-boss and sharp are dependencies of @tm/pipeline, not of @tm/scheduler: reach them through the pipeline package so
// that the test uses the very copy `workPipeline` was built against (one class, one lockfile entry).
import { PgBoss } from '../../../pipeline/node_modules/pg-boss'
import sharp from '../../../pipeline/node_modules/sharp'
import { PIPELINE_DEAD_QUEUE, PIPELINE_QUEUE, workPipeline } from '../../../pipeline/src/consumer-main'
import type { PipelineDeps } from '../../../pipeline/src/consumer'
import { runPipeline } from '../../../pipeline/src/pipeline'
import { remuxRecording } from '../../../pipeline/src/remux'
import { DockerError, FakeDocker, type LaunchDeps } from '../../src/index'

const run = promisify(execFile)

export const MASTER = Buffer.alloc(32, 9)
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const PUBLIC_URL = 'https://tm.example'
/** A Zoom link with a passcode: it must never reach a ping, the meeting page data or a summary. */
export const ZOOM_LINK = 'https://example.zoom.us/j/81234567890?pwd=SECRETPASSCODE123'
export const GOOD_KEY = 'sk-good-key-0001'

// --- Docker -------------------------------------------------------------------------------------------------------

/** A FakeDocker whose proxy can go away: `down` makes `inspect` and `stop` fail the way an unreachable proxy does. */
export class FlakyDocker extends FakeDocker {
  down = false

  override async inspect(id: string) {
    if (this.down) throw new DockerError('inspect', 0, 'proxy unreachable')
    return super.inspect(id)
  }

  override async stop(id: string, timeoutS: number) {
    if (this.down) throw new DockerError('stop', 0, 'proxy unreachable')
    return super.stop(id, timeoutS)
  }

  /** Docker reports the container `name` as gone (it exited and AutoRemove removed it). */
  gone(name: string): void {
    this.inspectResults.set(name, null)
  }
}

// --- ntfy ---------------------------------------------------------------------------------------------------------

export interface SeenPing {
  auth: string | null
  title: string
  message: string
  topic: string
  priority: number
  actions: { label: string; url: string }[]
}

export interface NtfyStub {
  url: string
  pings: SeenPing[]
  titles(): string[]
  stop(): void
}

export function startNtfyStub(): NtfyStub {
  const pings: SeenPing[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as Record<string, any>
      pings.push({
        auth: req.headers.get('authorization'),
        title: String(body.title),
        message: String(body.message),
        topic: String(body.topic),
        priority: Number(body.priority),
        actions: body.actions ?? []
      })
      return Response.json({ id: 'x' })
    }
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    pings,
    titles: () => pings.map((p) => p.title),
    stop: () => void server.stop(true)
  }
}

/** The ntfy admin API as a fake: it hands out one fixed token. */
export class FakeNtfyAdmin implements NtfyAdmin {
  readonly calls: string[] = []
  static readonly TOKEN = 'tk_fake_member_token'
  async addUser(username: string) {
    this.calls.push(`addUser ${username}`)
  }
  async allow(username: string, topic: string) {
    this.calls.push(`allow ${username} ${topic}`)
  }
  async createToken(username: string) {
    this.calls.push(`createToken ${username}`)
    return FakeNtfyAdmin.TOKEN
  }
  async deleteUser(username: string) {
    this.calls.push(`deleteUser ${username}`)
  }
}

// --- The AI provider ----------------------------------------------------------------------------------------------

export interface AiStub {
  /** `http://127.0.0.1:<port>/v1`. */
  url: string
  /** Only this bearer key is accepted; any other gets 401, which the pipeline reads as a rejected key. */
  validKey: string
  /** Bearer keys seen, in order. */
  keysSeen: string[]
  /** Models called, in order. */
  models: string[]
  /** While set, a summary-model call waits for it to resolve (after the call has been recorded). */
  hold: Promise<void> | null
  /** Resolves when the first held call has arrived. */
  arrived: Promise<void>
  stop(): void
}

const INVENTORY = {
  sessionLabel: 'Week 7: Clustering',
  nextAction: 'Submit assignment 2',
  items: [
    {
      kind: 'deadline',
      text: 'Submit assignment 2',
      due: '2026-11-01T23:59',
      source: 'slide',
      ref: 'slide 1',
      conflicts: []
    }
  ],
  covered: ['k-means clustering']
}

export function startAiStub(validKey: string): AiStub {
  let resolveArrived!: () => void
  const stub: AiStub = {
    url: '',
    validKey,
    keysSeen: [],
    models: [],
    hold: null,
    arrived: new Promise<void>((r) => (resolveArrived = r)),
    stop: () => undefined
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as { model: string }
      const key = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
      stub.keysSeen.push(key)
      stub.models.push(body.model)
      if (key !== stub.validKey) return new Response('invalid api key', { status: 401 })
      if (body.model === DEFAULT_MODELS.summary && stub.hold) {
        resolveArrived()
        await stub.hold
      }
      const content =
        body.model === DEFAULT_MODELS.vision
          ? { title: 'Week 7: Clustering', text: 'Assignment 2 is due on 1 November.' }
          : INVENTORY
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] })
    }
  })
  stub.url = `http://127.0.0.1:${server.port}/v1`
  stub.stop = () => void server.stop(true)
  return stub
}

export const keyTester: KeyTester = {
  dashscope: async () => ({ ok: true }),
  modelscope: async () => ({ ok: true })
}

// --- The stack ----------------------------------------------------------------------------------------------------

export interface Stack {
  base: string
  env: SpecEnv
  db: Db
  boss: PgBoss
  queue: Queue
  docker: FlakyDocker
  ntfy: NtfyStub
  ai: AiStub
  admin: FakeNtfyAdmin
  notifier: Notifier
  /** LaunchDeps with the real remux, the real notifier (through the ntfy stub) and the fake Docker. */
  deps: LaunchDeps
  /** The segment clip the worker "recorded" (two seconds of H.264 and AAC in Matroska). */
  clip: string
  /** The pipeline consumer deps. `run` points the AI base URL at the stub, and records the config it was given. */
  pipelineDeps: PipelineDeps
  /** Every JobConfig the pipeline consumer passed to `run` (the AI key is the member's real saved key). */
  pipelineConfigs: JobConfig[]
  startConsumer(): Promise<void>
  stopConsumer(): Promise<void>
  teardown(): Promise<void>
}

const ENV_KEYS = [
  'DATABASE_URL',
  'TM_DATA_ROOT',
  'TM_PUBLIC_URL',
  'TM_MASTER_KEY_FILE',
  'TM_WORKER_UID',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_ORG',
  'NTFY_URL'
] as const

export async function makeClip(path: string): Promise<void> {
  await run('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'],
    ...['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
    ...['-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
    path
  ])
}

export async function startStack(): Promise<Stack> {
  const base = await mkdtemp('/home/user/.cache/tm-tmp/e2e-flow-')
  const ntfy = startNtfyStub()
  const ai = startAiStub(GOOD_KEY)
  const env: SpecEnv = {
    dataRoot: `${base}/data`,
    profileRoot: `${base}/profiles`,
    publicUrl: PUBLIC_URL,
    ntfyUrl: ntfy.url
  }
  await mkdir(env.dataRoot, { recursive: true, mode: 0o755 })
  await mkdir(env.profileRoot, { recursive: true, mode: 0o755 })

  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  const db = await createTestDb()
  await writeFile(`${base}/master.key`, `${MASTER.toString('base64')}\n`, { mode: 0o600 })
  Object.assign(process.env, {
    DATABASE_URL: testDbUrl(db),
    TM_DATA_ROOT: env.dataRoot,
    TM_PUBLIC_URL: PUBLIC_URL,
    TM_MASTER_KEY_FILE: `${base}/master.key`,
    // The scheduler refuses host directories not owned by the worker uid; on this host that is simply our own.
    TM_WORKER_UID: String(process.getuid!()),
    GITHUB_CLIENT_ID: 'e2e-client',
    GITHUB_CLIENT_SECRET: 'e2e-client-secret',
    GITHUB_ORG: 'tolonglabs',
    NTFY_URL: ntfy.url
  })

  const boss = new PgBoss({ connectionString: testDbUrl(db), supervise: false, schedule: false })
  boss.on('error', (e) => console.error(`e2e boss error: ${e.name}`))
  await boss.start()
  // What the scheduler's main creates before the website sends (TASK 21 carry (f)); `workPipeline` configures the two
  // pipeline queues later, when a test starts the consumer.
  for (const name of [
    QUEUES.expand,
    QUEUES.launch,
    QUEUES.pipeline,
    PIPELINE_DEAD_QUEUE,
    QUEUES.deleteOccurrence,
    QUEUES.retention
  ])
    await boss.createQueue(name)
  const queue = bossQueue(boss)

  const docker = new FlakyDocker()
  const notifier = memberNotifier(db, MASTER, ntfy.url)
  const deps: LaunchDeps = { db, queue, docker, notifier, master: MASTER, env, remux: remuxRecording, exitPollMs: 25 }

  const pipelineConfigs: JobConfig[] = []
  const pipelineDeps: PipelineDeps = {
    db,
    notifier,
    queue,
    master: MASTER,
    env,
    // The one seam to the AI provider: the config the consumer built (DashScope URL, the member's own key) goes to the
    // stub instead. Everything else in the config is the consumer's.
    run: (cfg, signal) => {
      pipelineConfigs.push(cfg)
      return runPipeline({ ...cfg, ai: { ...cfg.ai, baseUrl: ai.url } }, { pingOnKeyError: false, signal })
    },
    remux: remuxRecording
  }

  const clip = `${base}/clip.mkv`
  await makeClip(clip)

  return {
    base,
    env,
    db,
    boss,
    queue,
    docker,
    ntfy,
    ai,
    admin: new FakeNtfyAdmin(),
    notifier,
    deps,
    clip,
    pipelineDeps,
    pipelineConfigs,
    // Retries are 1 s apart instead of 180 s: nothing else differs from the production queue settings.
    startConsumer: async () => {
      // The heartbeat queues the pipeline job to start 20 s later; the test does not wait for that.
      await db.execute(
        sql`update pgboss.job set start_after = now() where name = ${QUEUES.pipeline} and state = 'created'`
      )
      await workPipeline(boss, pipelineDeps, { ...PIPELINE_QUEUE, retryDelay: 1 })
    },
    stopConsumer: async () => {
      await boss.offWork(QUEUES.pipeline)
      await boss.offWork(PIPELINE_DEAD_QUEUE)
    },
    async teardown() {
      await boss.stop({ graceful: false, close: true })
      await closeDb()
      await dropAllTestDbs()
      ntfy.stop()
      ai.stop()
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      await rm(base, { recursive: true, force: true })
    }
  }
}

// --- A member -----------------------------------------------------------------------------------------------------

export interface Member {
  memberId: string
  identityId: string
  scope: MemberScope
  /** The member's ntfy topic: the pings they received are the stub's pings on it. */
  topic: string
  /** The `Cookie` header of a real Better Auth session for this member. */
  cookie: string
  authUserId: string
}

/**
 * Better Auth's signed session cookie for a session row: `<token>.<base64 HMAC-SHA256>`, percent-encoded, under the
 * `__Secure-` name that an https `TM_PUBLIC_URL` selects. The secret is the one derived from the master key.
 */
export function sessionCookie(token: string): string {
  const signature = createHmac('sha256', authSecret(MASTER)).update(token).digest('base64')
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
}

/**
 * A member who has done the set-up: signed in (a real Better Auth session row), one identity, an AI key saved and
 * tested through the fake tester, ntfy provisioned through the fake admin API.
 */
export async function newMember(stack: Stack, name = 'Alice'): Promise<Member> {
  const { db } = stack
  const login = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}`
  const [row] = await db.insert(members).values({ githubLogin: login, displayName: name }).returning()
  const memberId = row!.id
  const authUserId = await seedAuthUser(db, { session: true })
  await db.update(members).set({ authUserId }).where(eq(members.id, memberId))
  const [session] = await db
    .select({ token: schema.auth_session.token })
    .from(schema.auth_session)
    .where(eq(schema.auth_session.userId, authUserId))
  const scope = createScope(db, memberId)
  const identity = await createIdentity(scope, {
    name: 'Main',
    runLocation: 'server',
    zoomGuestName: `${name} Student`
  })
  const saved = await saveAiKeys(
    scope,
    { dashscopeKey: GOOD_KEY },
    { master: MASTER, tester: keyTester, now: new Date() }
  )
  if (!saved.ok) throw new Error('the fake key tester refused the key')
  const { topic } = await ensureNtfy(scope, stack.admin, MASTER)
  return { memberId, identityId: identity.id, scope, topic, cookie: sessionCookie(session!.token), authUserId }
}

// --- The timetable ------------------------------------------------------------------------------------------------

export interface Lecture {
  entryId: string
  occurrenceId: string
  start: Date
  end: Date
}

/** Saves a one-off lecture that starts `inMinutes` from now (rounded up to the minute) through `saveEntry`. */
export async function saveLecture(
  stack: Stack,
  member: Member,
  inMinutes = 61,
  name = 'Data Mining'
): Promise<Lecture> {
  const now = new Date()
  const start = new Date(Math.ceil((now.getTime() + inMinutes * MINUTE) / MINUTE) * MINUTE)
  const end = new Date(start.getTime() + HOUR)
  const tz = (await member.scope.me()).timeZone
  const s = localParts(start, tz)
  const e = localParts(end, tz)
  const hhmm = (p: string) => `${p.slice(0, 2)}:${p.slice(2)}`
  const deps: EntryDeps = {
    queue: stack.queue,
    notifier: stack.notifier,
    ensureNtfy: async () => void (await ensureNtfy(member.scope, stack.admin, MASTER)),
    now,
    publicUrl: PUBLIC_URL
  }
  const { entryId } = await saveEntry(
    member.scope,
    {
      name,
      type: 'lecture',
      repeat: { kind: 'once', date: s.date },
      start: hhmm(s.hhmm),
      end: hhmm(e.hhmm),
      identityId: member.identityId,
      link: { kind: 'fixed', url: ZOOM_LINK },
      transcription: 'live'
    },
    deps
  )
  const [occ] = await stack.db.select().from(occurrences).where(eq(occurrences.entryId, entryId))
  if (!occ) throw new Error('saveEntry made no occurrence')
  return { entryId, occurrenceId: occ.id, start: occ.scheduledStart, end: occ.scheduledEnd }
}

/** Puts the stack back for the next scenario: nothing active, Docker up, the AI provider open and not held. */
export async function resetStack(stack: Stack): Promise<void> {
  stack.docker.down = false
  stack.ai.validKey = GOOD_KEY
  stack.ai.hold = null
  const active = [
    'starting',
    'verifying_accounts',
    'waiting_for_signin',
    'watching_for_link',
    'joining',
    'in_lobby',
    'in_meeting',
    'restarting',
    'leaving',
    'uploading',
    'transcribing',
    'post_processing'
  ]
  await stack.db.execute(
    sql`update occurrences set state = 'failed', container_name = null where state in (${sql.join(
      active.map((s) => sql`${s}`),
      sql`, `
    )})`
  )
  await stack.db.execute(sql`update profiles set held_by = null, held_since = null`)
}

/** The jobs pg-boss holds in a queue for an occurrence (read from its table: nothing consumes `launch` in this build). */
export async function queuedJobs(stack: Stack, queueName: string, occurrenceId: string) {
  const res = await stack.db.execute(
    sql`select id, state, data, start_after, retry_count from pgboss.job where name = ${queueName} and data->>'occurrenceId' = ${occurrenceId} order by created_on`
  )
  return (
    res.rows as {
      id: string
      state: string
      data: Record<string, unknown>
      start_after: string | Date
      retry_count: number
    }[]
  ).map((r) => ({ ...r, start_after: new Date(r.start_after) }))
}

// --- The worker ---------------------------------------------------------------------------------------------------

export const ROUTE_URL = `${PUBLIC_URL}/api/control/heartbeat`

export interface BeatOptions {
  events?: { type: string; data: Record<string, unknown>; at?: Date }[]
  /** Whether the beat carries a `state` event for the state (a real worker sends one for each change). Default true. */
  stateEvent?: boolean
  recording?: boolean
  participants?: number | null
  /** Overrides the bearer token. */
  token?: string
}

/** What a worker "running in a container" does: reads its token from its job file and posts heartbeats. */
export class FakeWorker {
  constructor(
    private readonly stack: Stack,
    readonly identityId: string,
    readonly occurrenceId: string,
    readonly attempt: number,
    readonly token: string
  ) {}

  /** Reads the job file the launcher wrote for this attempt, the way the container's `--job` argument would. */
  static async fromJobFile(
    stack: Stack,
    identityId: string,
    occurrenceId: string,
    attempt: number
  ): Promise<FakeWorker> {
    const path = `${stack.env.profileRoot}/${identityId}/job/tm-worker-${occurrenceId}-a${attempt}.json`
    const job = JobConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    if (job.control === null) throw new Error('the job file has no control channel')
    return new FakeWorker(stack, identityId, occurrenceId, attempt, job.control.token)
  }

  get dataDir(): string {
    return `${this.stack.env.dataRoot}/occurrences/${this.occurrenceId}`
  }

  /** The last participant count reported: the real worker keeps sending it after it has left. */
  private participants: number | null = null

  /** One `POST /api/control/heartbeat`, through the exported route function. */
  async beat(state: OccurrenceState, opts: BeatOptions = {}): Promise<{ status: number; body: any }> {
    const { POST } = await import('../../../web/app/api/control/heartbeat/route')
    const events = [
      ...(opts.stateEvent === false ? [] : [{ type: 'state', data: { state }, at: new Date() }]),
      ...(opts.events ?? [])
    ].map((e) => ({
      occurrenceId: this.occurrenceId,
      attempt: this.attempt,
      at: (e.at ?? new Date()).toISOString(),
      type: e.type,
      data: e.data
    }))
    if (opts.participants !== undefined) this.participants = opts.participants
    const res = await POST(
      new Request(ROUTE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token ?? this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          occurrenceId: this.occurrenceId,
          attempt: this.attempt,
          state,
          recording: opts.recording ?? false,
          participants: this.participants,
          events
        })
      })
    )
    return { status: res.status, body: await res.json() }
  }

  /** Recording segments, as the recorder leaves them (the pipeline joins them; this worker never wrote `meeting.mkv`). */
  async writeSegments(count = 2): Promise<void> {
    await mkdir(`${this.dataDir}/recording`, { recursive: true })
    for (let n = 1; n <= count; n++) {
      await Bun.write(
        `${this.dataDir}/recording/attempt_${this.attempt}_seg_${String(n).padStart(3, '0')}.mkv`,
        Bun.file(this.stack.clip)
      )
    }
  }
}

/** A `form` event in the 01b `formEventData` shape (a Google form, submitted). */
export function formEvent(over: Record<string, unknown> = {}): { type: string; data: Record<string, unknown> } {
  return {
    type: 'form',
    data: {
      formId: 'a1b2c3d4e5f60718',
      state: 'submitted',
      provider: 'google',
      source: 'qr',
      sender: null,
      senderRole: null,
      trustReason: 'qr_on_screen',
      reason: null,
      seenAt: new Date(Date.now() - 2 * MINUTE).toISOString(),
      submittedAt: new Date(Date.now() - MINUTE).toISOString(),
      url: 'https://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform',
      finalUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform',
      fieldsFilled: ['full_name', 'attendance_confirmation'],
      ...over
    }
  }
}

/** A form that came from the meeting chat (the lecturer posted the link). */
export function chatFormEvent(): { type: string; data: Record<string, unknown> } {
  return formEvent({
    formId: '0f1e2d3c4b5a6978',
    source: 'meeting_chat',
    sender: 'Dr Lecturer',
    senderRole: 'host',
    trustReason: 'host',
    state: 'needs_member',
    submittedAt: null,
    reason: null,
    fieldsFilled: [],
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSchat/viewform',
    finalUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSchat/viewform'
  })
}

/** A 1920x1080 black stage with one white slide-sized panel, as the recorder's keyframes look. */
async function stageFrame(): Promise<Buffer> {
  const panel = await sharp({
    create: { width: 1000, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
    .png()
    .toBuffer()
  return sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: panel, left: 100, top: 100 }])
    .png()
    .toBuffer()
}

/**
 * Everything else a worker leaves in the occurrence directory (01a/01b layout): the live transcript, the chat, the
 * recording attempts, a keyframe, the form record and its screenshot, and `outcome.json`. The recording segments are
 * `FakeWorker.writeSegments`. `attempts` lists the recorder attempts (milliseconds from the first start).
 */
export async function writeMeetingOutput(
  worker: FakeWorker,
  lecture: Lecture,
  opts: { attempts?: { startMs: number; stopMs: number | null }[]; formId?: string } = {}
): Promise<void> {
  const dir = worker.dataDir
  const formId = opts.formId ?? 'a1b2c3d4e5f60718'
  const origin = lecture.start.getTime()
  const attempts = opts.attempts ?? [{ startMs: 0, stopMs: 3_000 }]
  await mkdir(`${dir}/transcript`, { recursive: true })
  await mkdir(`${dir}/frames`, { recursive: true })
  await mkdir(`${dir}/forms/${formId}`, { recursive: true })
  await mkdir(`${dir}/recording`, { recursive: true })

  const lines = [
    { startMs: 0, endMs: 1500, text: 'Selamat petang semua.' },
    { startMs: 1800, endMs: 2900, text: 'Today we cover k-means clustering.' }
  ]
  await writeFile(`${dir}/transcript/live.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  await writeFile(
    `${dir}/recording/attempts.json`,
    JSON.stringify(
      attempts.map((a, i) => ({
        attempt: i + 1,
        startedAt: new Date(origin + a.startMs).toISOString(),
        stoppedAt: a.stopMs === null ? null : new Date(origin + a.stopMs).toISOString()
      }))
    )
  )
  const chat = [
    {
      key: 'm1',
      sender: 'Dr Lecturer',
      senderRole: 'host',
      time: '8:41 PM',
      seenAt: new Date(origin + 60_000).toISOString(),
      // The lecturer's message carries the join link and passcode: both must be cut from every output.
      text: `Assignment 2 is due Sunday. Rejoin at ${ZOOM_LINK} passcode SECRETPASSCODE123`,
      links: [],
      replyTo: null
    }
  ]
  await writeFile(`${dir}/chat.jsonl`, chat.map((m) => JSON.stringify(m)).join('\n') + '\n')

  await Bun.write(`${dir}/frames/0001.png`, await stageFrame())
  const keyframe = {
    occurrenceId: worker.occurrenceId,
    attempt: worker.attempt,
    at: new Date().toISOString(),
    type: 'keyframe',
    data: { file: 'frames/0001.png', offsetMs: 2000, region: { x: 100, y: 100, width: 1000, height: 600 } }
  }
  await writeFile(`${dir}/events.jsonl`, JSON.stringify(keyframe) + '\n')

  const record = sampleRecord({
    formId,
    occurrenceId: worker.occurrenceId,
    state: 'submitted',
    submittedAt: new Date(origin + 90_000).toISOString(),
    seenAt: new Date(origin + 30_000).toISOString(),
    trustReason: 'qr_on_screen'
  })
  await writeFile(`${dir}/forms/${formId}/record.json`, JSON.stringify(record))
  await Bun.write(`${dir}/forms/${formId}/filled.png`, await stageFrame())

  await writeFile(
    `${dir}/outcome.json`,
    JSON.stringify({
      result: 'completed',
      endedBy: 'meeting_ended',
      reason: null,
      joinedAt: new Date(origin).toISOString(),
      endedAt: new Date(origin + 3_000).toISOString()
    })
  )
}

/** Drives a worker from `starting` to `in_meeting` the way a real one reports it (each change is a state event). */
export async function joinMeeting(worker: FakeWorker, over: { forms?: boolean } = {}): Promise<void> {
  for (const state of ['starting', 'verifying_accounts', 'watching_for_link', 'joining', 'in_lobby'] as const) {
    const r = await worker.beat(state, { stateEvent: state !== 'starting' })
    if (r.status !== 200) throw new Error(`heartbeat ${state} answered ${r.status}`)
  }
  const r = await worker.beat('in_meeting', {
    recording: true,
    participants: 31,
    events: over.forms === false ? [] : [formEvent(), chatFormEvent()]
  })
  if (r.status !== 200) throw new Error(`heartbeat in_meeting answered ${r.status}`)
}

/** Reports `leaving` and `uploading`. `transcribing` is the caller's, once the files are written. */
export async function finishMeeting(worker: FakeWorker): Promise<void> {
  for (const state of ['leaving', 'uploading'] as const) {
    const r = await worker.beat(state, { recording: false })
    if (r.status !== 200) throw new Error(`heartbeat ${state} answered ${r.status}`)
  }
}

export async function rowOf(stack: Stack, occurrenceId: string) {
  const [row] = await stack.db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  return row!
}

/** Polls `check` until it is truthy (queue-driven steps finish on pg-boss's schedule). */
export async function until<T>(
  what: string,
  check: () => Promise<T | false | null | undefined>,
  ms = 30_000
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await Bun.sleep(100)
  }
}

export const sha256hex = (text: string) => createHash('sha256').update(text).digest('hex')
