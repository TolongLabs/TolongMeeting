// Helpers for the companion, export and run-location end-to-end scenarios (../e2e-companion.test.ts): a signed-in
// request context for the member routes, a fake PC that speaks to the real device routes with a real device token, and
// the steps that bring a lecture to a given point. See ./harness.ts for what is real and what is faked.
import { mock } from 'bun:test'
import { expect } from 'bun:test'
import { eq } from 'drizzle-orm'
import { companionJobs } from '@tm/web/db'
import {
  PUBLIC_URL,
  FakeWorker,
  finishMeeting,
  joinMeeting,
  rowOf,
  saveLecture,
  until,
  writeMeetingOutput
} from './harness'
import { launchOccurrence, monitorTick } from '../../src/index'
import type { Lecture, Member, Stack } from './harness'

// --- Sign-in for the member routes ---------------------------------------------------------------------------------
// `requireMember` reads the request's cookies through `next/headers`, which only works inside a Next request. The real
// Better Auth (`getAuth()`, `getSession`, the session row, the signed cookie) runs; only the request context is supplied.

const session = { cookie: '' }
const nextHeaders = Bun.resolveSync('next/headers', `${import.meta.dir}/../../../web/lib`)
const realNextHeaders = await import(nextHeaders)

/** From now on the member routes see this member's session cookie (`null`: nobody signed in). */
export function signInAs(member: Member | null): void {
  session.cookie = member?.cookie ?? ''
}

let installs = 0
/**
 * Installs the `next/headers` stand-in. Call `restore` in the file's `afterAll`. Test files of one `bun test` run share
 * the module registry, so the stand-in stays until the last file that installed it has restored it.
 */
export function installSession(): { restore(): void } {
  installs++
  mock.module(nextHeaders, () => ({ ...realNextHeaders, headers: async () => new Headers({ cookie: session.cookie }) }))
  return {
    restore: () => {
      if (--installs === 0) mock.module(nextHeaders, () => realNextHeaders)
    }
  }
}

/** A route function called the way Next calls it: a `Request` and the dynamic params. */
type RouteFn = (request: Request, ctx: { params: Promise<any> }) => Promise<Response>

/** A same-origin member request (the browser sends `Origin`, and the member routes refuse a request without it). */
export function memberRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('origin', PUBLIC_URL)
  return new Request(`${PUBLIC_URL}${path}`, { ...init, headers })
}

export async function callMember(
  as: Member | null,
  route: RouteFn,
  path: string,
  params: Record<string, string>,
  init: RequestInit = {}
): Promise<Response> {
  signInAs(as)
  return route(memberRequest(path, init), { params: Promise.resolve(params) })
}

// --- A paired PC -------------------------------------------------------------------------------------------------

export interface Job {
  id: string
  kind: string
  state: string
  occurrenceId: string
  attempts: number
  payload: Record<string, any>
}

/** A Whisper `json` output, as the companion uploads it. */
export function whisperJson(text: string): string {
  return JSON.stringify({
    text,
    language: 'en',
    segments: [
      { start: 0, end: 1.4, text: ' Selamat petang semua.' },
      { start: 1.8, end: 2.9, text }
    ]
  })
}

/** The three files of an upload (`txt`, `srt`, `json`) as a multipart `FormData`. */
export function transcriptForm(text: string, over: Partial<Record<'txt' | 'srt' | 'json', string>> = {}): FormData {
  const form = new FormData()
  form.set('txt', over.txt ?? `Selamat petang semua.\n${text}\n`)
  form.set('srt', over.srt ?? `1\n00:00:00,000 --> 00:00:01,400\nSelamat petang semua.\n`)
  form.set('json', over.json ?? whisperJson(text))
  return form
}

/**
 * A PC with the companion app: it holds the device token that the real pairing route gave it and calls the real
 * `/api/companion/*` route functions with it. Nothing here knows the token's hash or touches the database.
 */
export class FakePc {
  private constructor(
    readonly deviceId: string,
    readonly token: string,
    readonly name: string
  ) {}

  /** The member asks for a pairing code (member route), the PC trades it for its token (code route, no session). */
  static async pair(member: Member, name = 'Lab PC'): Promise<FakePc> {
    const codeRoute = await import('../../../web/app/api/devices/pairing-code/route')
    const made = await callMember(member, codeRoute.POST, '/api/devices/pairing-code', {}, { method: 'POST' })
    if (made.status !== 200) throw new Error(`pairing code answered ${made.status}`)
    const { code } = (await made.json()) as { code: string }
    const pairRoute = await import('../../../web/app/api/companion/pair/route')
    const res = await pairRoute.POST(
      new Request(`${PUBLIC_URL}/api/companion/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({ code, deviceName: name })
      })
    )
    if (res.status !== 200) throw new Error(`pairing answered ${res.status}`)
    const body = (await res.json()) as { deviceId: string; token: string }
    return new FakePc(body.deviceId, body.token, name)
  }

  /** The same device with another (wrong) token, for the refusals. */
  withToken(token: string): FakePc {
    return new FakePc(this.deviceId, token, this.name)
  }

  private request(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.token}`)
    return new Request(`${PUBLIC_URL}${path}`, { ...init, headers })
  }

  async jobs(): Promise<Job[]> {
    const { GET } = await import('../../../web/app/api/companion/jobs/route')
    const res = await GET(this.request('/api/companion/jobs'), { params: Promise.resolve({}) } as never)
    if (res.status !== 200) throw new Error(`job list answered ${res.status}`)
    return ((await res.json()) as { jobs: Job[] }).jobs
  }

  async claim(jobId: string): Promise<Response> {
    const { POST } = await import('../../../web/app/api/companion/jobs/[id]/claim/route')
    return POST(this.request(`/api/companion/jobs/${jobId}/claim`, { method: 'POST' }), {
      params: Promise.resolve({ id: jobId })
    })
  }

  async progress(jobId: string, body = ''): Promise<Response> {
    const { POST } = await import('../../../web/app/api/companion/jobs/[id]/progress/route')
    return POST(this.request(`/api/companion/jobs/${jobId}/progress`, { method: 'POST', body: body || undefined }), {
      params: Promise.resolve({ id: jobId })
    })
  }

  async audio(jobId: string, range?: string): Promise<Response> {
    const { GET } = await import('../../../web/app/api/companion/jobs/[id]/audio/route')
    return GET(this.request(`/api/companion/jobs/${jobId}/audio`, range ? { headers: { range } } : {}), {
      params: Promise.resolve({ id: jobId })
    })
  }

  /** `POST /api/companion/jobs/<id>/transcript` with a multipart body. */
  async upload(jobId: string, form: FormData | { body: BodyInit; headers: Record<string, string> }): Promise<Response> {
    const { POST } = await import('../../../web/app/api/companion/jobs/[id]/transcript/route')
    const init: RequestInit =
      form instanceof FormData
        ? { method: 'POST', body: form }
        : { method: 'POST', body: form.body, headers: form.headers }
    return POST(this.request(`/api/companion/jobs/${jobId}/transcript`, init), {
      params: Promise.resolve({ id: jobId })
    })
  }

  /** Opens the command stream; read it with `readStream`. Abort `signal` to close it. */
  async events(signal: AbortSignal, lastEventId?: number): Promise<Response> {
    const { GET } = await import('../../../web/app/api/companion/events/route')
    return GET(
      this.request('/api/companion/events', {
        signal,
        headers: lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }
      }),
      { params: Promise.resolve({}) } as never
    )
  }
}

/** Reads a server-sent-event response for `ms` milliseconds (or until `until` says stop) and returns the text. */
export async function readStream(res: Response, ms: number, until: (text: string) => boolean = () => false) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !until(text)) {
    const next = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)])
    if (next === null || next.done) break
    text += decoder.decode(next.value)
  }
  reader.releaseLock()
  return text
}

// --- Steps ---------------------------------------------------------------------------------------------------------

/** A saved lecture, launched at T-60, and the worker that reads the job file the launcher wrote. */
export async function launchedLecture(
  stack: Stack,
  member: Member,
  name = 'Data Mining',
  transcription: 'live' | 'native' = 'live'
) {
  const lecture = await saveLecture(stack, member, 61, name, transcription)
  const tMinus60 = new Date(lecture.start.getTime() - 3_600_000)
  const job = { occurrenceId: lecture.occurrenceId, scheduledStart: lecture.start.toISOString() }
  expect(await launchOccurrence(stack.deps, job, tMinus60)).toBe('launched')
  const worker = await FakeWorker.fromJobFile(stack, member.identityId, lecture.occurrenceId, 1)
  return { lecture, worker, tMinus60, id: lecture.occurrenceId }
}

/** The worker's end of a meeting: its files, then `leaving`, `uploading` and `transcribing`. */
export async function endMeeting(worker: FakeWorker, lecture: Lecture): Promise<void> {
  await worker.writeSegments(1)
  await writeMeetingOutput(worker, lecture)
  await finishMeeting(worker)
  expect((await worker.beat('transcribing')).status).toBe(200)
}

/** Docker reports the worker's container gone and the monitor lets go of it. */
export async function releaseWorker(stack: Stack, id: string): Promise<void> {
  const row = await rowOf(stack, id)
  stack.docker.gone(row.containerName!)
  expect((await monitorTick(stack.deps, new Date())).released).toEqual([id])
}

/** A meeting whose worker has finished (`transcribing`, the container released) and whose pipeline job is queued. */
export async function recordedLecture(
  stack: Stack,
  member: Member,
  name = 'Data Mining',
  transcription: 'live' | 'native' = 'live'
) {
  const made = await launchedLecture(stack, member, name, transcription)
  await joinMeeting(made.worker)
  await endMeeting(made.worker, made.lecture)
  return made
}

/** The native transcription job of an occurrence, once the pipeline consumer has cut the audio and created it. */
export async function nativeJobOf(stack: Stack, occurrenceId: string) {
  return until('the native transcription job', async () => {
    const [job] = await stack.db.select().from(companionJobs).where(eq(companionJobs.occurrenceId, occurrenceId))
    return job
  })
}
