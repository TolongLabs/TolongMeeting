import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  CompanionJobSchema,
  JobFailureReportSchema,
  LocalIdentitiesResponseSchema,
  MAX_LIST_ITEMS,
  NATIVE_UPLOAD_FIELDS,
  NATIVE_UPLOAD_MAX_FILE_BYTES,
  OccurrenceIdSchema,
  PreflightReportSchema,
  SummaryListItemSchema,
  type CompanionJob,
  type LocalIdentitiesResponse,
  type PreflightReport,
  type SummaryListItem
} from '@tm/core'
import { z } from 'zod'

// The website answers over HTTPS only (plain HTTP for localhost, which tests use). A bearer token goes in the
// `Authorization` header and nowhere else. Every answer is checked against a strict schema and a size cap, and every
// error is a fixed sentence: the server's own words never reach a log, a window or a notification.

const JSON_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 30 * 60_000
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024
const MAX_ERROR_BODY_BYTES = 1024
/** 16 GiB, the same ceiling the job payload allows for a recording. */
export const MAX_AUDIO_BYTES = 16 * 1024 ** 3
const FAIL_REASON_MAX = 1000

/** The server says this PC's token is revoked or unknown. The token is already gone from this PC when you catch it. */
export class DeviceRevokedError extends Error {
  constructor() {
    super('PC was unpaired')
    this.name = 'DeviceRevokedError'
  }
}

/** The website answered with a status the app did not expect. The message holds the status and nothing the server said. */
export class CompanionApiError extends Error {
  constructor(readonly status: number) {
    super(`The website answered with HTTP ${status}`)
    this.name = 'CompanionApiError'
  }
}

/** The answer was not what the app's schema allows, or it was too large. */
export class InvalidResponseError extends Error {
  constructor() {
    super('The website sent an answer this app does not understand')
    this.name = 'InvalidResponseError'
  }
}

/**
 * The origin to talk to: `https:`, or `http:` for `localhost` / `127.0.0.1` only. A login, a query, a fragment or a
 * path is refused rather than dropped, so a typo is visible. Throws a fixed sentence that does not repeat the input.
 */
export function serverOrigin(raw: string): string {
  const refuse = () => new Error('The website address must be an https address (http only for localhost)')
  let url: URL
  try {
    url = new URL(raw)
  } catch (e) {
    if (e instanceof TypeError) throw refuse()
    throw e
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local)
  if (!schemeOk || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw refuse()
  if (url.pathname !== '/') throw refuse()
  return url.origin
}

const JobsAnswer = z.strictObject({ jobs: z.array(CompanionJobSchema).max(MAX_LIST_ITEMS) })
const SummariesAnswer = z.strictObject({ summaries: z.array(SummaryListItemSchema).max(MAX_LIST_ITEMS) })
const RevokedBody = z.strictObject({ error: z.literal('device_revoked_or_unknown') })
const ContentRange = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/
const UnsatisfiedRange = /^bytes \*\/(\d{1,16})$/

function id(value: string): string {
  if (!OccurrenceIdSchema.safeParse(value).success) throw new TypeError('not a valid id')
  return value
}

/** The body as text, cut off at `max` bytes. A larger or non-UTF-8 body is an `InvalidResponseError`. */
async function readText(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > max) {
    await res.body?.cancel()
    throw new InvalidResponseError()
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new InvalidResponseError()
    }
    chunks.push(value)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch (e) {
    if (e instanceof TypeError) throw new InvalidResponseError()
    throw e
  }
}

/** Parses a size-capped JSON answer with a strict schema. */
export async function readJson<T>(res: Response, schema: z.ZodType<T>, max = MAX_JSON_BYTES): Promise<T> {
  const text = await readText(res, max)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    if (e instanceof SyntaxError) throw new InvalidResponseError()
    throw e
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new InvalidResponseError()
  return parsed.data
}

/** Drops an answer the app does not read. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel()
}

export interface CompanionApiOptions {
  serverUrl: string
  /** The device token, read for each request and not kept. `null` means this PC is not paired. */
  token: () => Promise<string | null>
  /** Called after the website refuses the token. The caller clears the secrets (see `handleRevoked`). */
  onRevoked: () => void
  fetch?: typeof fetch
}

export class CompanionApi {
  private readonly origin: string
  private readonly token: () => Promise<string | null>
  private readonly onRevoked: () => void
  private readonly send: (request: Request) => Promise<Response>

  constructor(opts: CompanionApiOptions) {
    this.origin = serverOrigin(opts.serverUrl)
    this.token = opts.token
    this.onRevoked = opts.onRevoked
    const f = opts.fetch ?? globalThis.fetch
    this.send = (request) => f(request)
  }

  async jobs(): Promise<CompanionJob[]> {
    const res = await this.call('GET', '/api/companion/jobs', { expect: [200] })
    return (await readJson(res, JobsAnswer)).jobs
  }

  /** The claimed job, or `null` when another PC holds it (409) or it is not yours (404). */
  async claim(jobId: string): Promise<CompanionJob | null> {
    const res = await this.call('POST', `/api/companion/jobs/${id(jobId)}/claim`, { expect: [200, 404, 409] })
    if (res.status !== 200) {
      await discard(res)
      return null
    }
    const job = await readJson(res, CompanionJobSchema)
    if (job.id !== jobId) throw new InvalidResponseError()
    return job
  }

  async progress(jobId: string): Promise<void> {
    await discard(await this.call('POST', `/api/companion/jobs/${id(jobId)}/progress`, { expect: [204] }))
  }

  /** Reports a failure. The reason is shown to the member, so control characters go and it is cut to 1000 characters. */
  async fail(jobId: string, error: string): Promise<void> {
    const reason =
      error
        .replace(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, FAIL_REASON_MAX) || 'The PC could not finish the job'
    const body = JSON.stringify(JobFailureReportSchema.parse({ error: reason }))
    await discard(
      await this.call('POST', `/api/companion/jobs/${id(jobId)}/fail`, {
        expect: [204],
        body,
        headers: { 'content-type': 'application/json' }
      })
    )
  }

  /** The identities that run on this PC and the worker image to pull. */
  async identities(): Promise<LocalIdentitiesResponse> {
    const res = await this.call('GET', '/api/companion/identities', { expect: [200] })
    return readJson(res, LocalIdentitiesResponseSchema)
  }

  /** Tells the website whether this PC can start the job's meeting (Docker running, enough memory, image pulled). */
  async preflight(jobId: string, report: PreflightReport): Promise<void> {
    const body = JSON.stringify(PreflightReportSchema.parse(report))
    await discard(
      await this.call('POST', `/api/companion/jobs/${id(jobId)}/preflight`, {
        expect: [204],
        body,
        headers: { 'content-type': 'application/json' }
      })
    )
  }

  /**
   * Downloads the recording to `dest`. Bytes land in `${dest}.part` first, and a later call resumes from the end of
   * that file with a `Range` request. The file is renamed to `dest` only when every byte has arrived.
   */
  async downloadAudio(jobId: string, dest: string, signal?: AbortSignal): Promise<void> {
    const part = `${dest}.part`
    await mkdir(dirname(dest), { recursive: true })
    let offset = await sizeOf(part)
    const headers: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {}
    const res = await this.call('GET', `/api/companion/jobs/${id(jobId)}/audio`, {
      expect: [200, 206, 416],
      headers,
      signal,
      timeoutMs: null
    })

    if (res.status === 416) {
      await discard(res)
      const total = UnsatisfiedRange.exec(res.headers.get('content-range') ?? '')?.[1]
      if (total !== undefined && Number(total) === offset) return void (await rename(part, dest))
      await rm(part, { force: true })
      throw new InvalidResponseError()
    }

    let expectedTotal: number | null
    if (res.status === 206) {
      const m = ContentRange.exec(res.headers.get('content-range') ?? '')
      const [start, end, total] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [NaN, NaN, NaN]
      if (start !== offset || end !== total - 1 || total > MAX_AUDIO_BYTES) {
        await discard(res)
        throw new InvalidResponseError()
      }
      expectedTotal = total
    } else {
      // The server ignored the range: start again from the beginning.
      offset = 0
      const declared = res.headers.get('content-length')
      expectedTotal = declared === null ? null : Number(declared)
      if (expectedTotal !== null && !(expectedTotal <= MAX_AUDIO_BYTES)) {
        await discard(res)
        throw new InvalidResponseError()
      }
    }

    const written = await appendBody(res, part, offset, expectedTotal)
    if (expectedTotal !== null && written !== expectedTotal) throw new InvalidResponseError()
    await rename(part, dest)
  }

  /** Sends the three whisper outputs as one multipart upload. */
  async uploadTranscript(jobId: string, files: { txt: string; srt: string; json: string }): Promise<void> {
    const form = new FormData()
    for (const field of NATIVE_UPLOAD_FIELDS) {
      const content = files[field]
      if (Buffer.byteLength(content) > NATIVE_UPLOAD_MAX_FILE_BYTES) throw new RangeError('transcript file too large')
      form.append(field, new Blob([content]), `audio.${field}`)
    }
    await discard(
      await this.call('POST', `/api/companion/jobs/${id(jobId)}/transcript`, {
        expect: [204],
        body: form,
        timeoutMs: UPLOAD_TIMEOUT_MS
      })
    )
  }

  /** Summaries ready after `after` (an ISO 8601 time). */
  async summaries(after: string): Promise<SummaryListItem[]> {
    const parsed = z.iso.datetime({ offset: true }).safeParse(after)
    if (!parsed.success) throw new TypeError('not a valid time')
    const res = await this.call('GET', `/api/companion/summaries?after=${encodeURIComponent(parsed.data)}`, {
      expect: [200]
    })
    return (await readJson(res, SummariesAnswer)).summaries
  }

  /** The summary as Markdown text. */
  async summary(occurrenceId: string): Promise<string> {
    const res = await this.call('GET', `/api/companion/summaries/${id(occurrenceId)}`, { expect: [200] })
    return readText(res, MAX_SUMMARY_BYTES)
  }

  /** The raw event stream, resumed after `lastEventId`. The caller reads and closes the body. */
  async events(lastEventId: number, signal: AbortSignal): Promise<Response> {
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) throw new RangeError('not a valid event id')
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    if (lastEventId > 0) headers['last-event-id'] = String(lastEventId)
    return this.call('GET', '/api/companion/events', { expect: [200], headers, signal, timeoutMs: null })
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    o: {
      expect: number[]
      headers?: Record<string, string>
      body?: BodyInit
      signal?: AbortSignal
      timeoutMs?: number | null
    }
  ): Promise<Response> {
    const token = await this.token()
    if (token === null) throw new DeviceRevokedError()
    const headers = new Headers(o.headers)
    headers.set('authorization', `Bearer ${token}`)
    const timeout = o.timeoutMs === null ? [] : [AbortSignal.timeout(o.timeoutMs ?? JSON_TIMEOUT_MS)]
    const signals = [...timeout, ...(o.signal ? [o.signal] : [])]
    const res = await this.send(
      new Request(new URL(path, this.origin), {
        method,
        headers,
        body: o.body,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined
      })
    )
    if (res.status === 401) await this.refused(res)
    if (!o.expect.includes(res.status)) {
      await discard(res)
      throw new CompanionApiError(res.status)
    }
    return res
  }

  /** A 401 unpairs the PC only when it carries the website's exact "revoked or unknown" answer. */
  private async refused(res: Response): Promise<never> {
    let revoked = false
    try {
      revoked = RevokedBody.safeParse(JSON.parse(await readText(res, MAX_ERROR_BODY_BYTES))).success
    } catch (e) {
      if (!(e instanceof SyntaxError || e instanceof InvalidResponseError)) throw e
    }
    if (!revoked) throw new CompanionApiError(401)
    this.onRevoked()
    throw new DeviceRevokedError()
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return 0
    throw e
  }
}

/** Streams the body into `file` starting at `offset` (0 truncates) and returns the file size. Stops at `limit` bytes. */
async function appendBody(res: Response, file: string, offset: number, limit: number | null): Promise<number> {
  const cap = limit ?? MAX_AUDIO_BYTES
  const handle = await open(file, offset > 0 ? 'a' : 'w', 0o600)
  let size = offset
  let overflow = false
  try {
    if (res.body) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > cap) {
          overflow = true
          await reader.cancel()
          break
        }
        await handle.write(value)
      }
    }
  } finally {
    await handle.close()
  }
  if (overflow) {
    // More bytes than the server announced: the partial file cannot be trusted for a resume.
    await rm(file, { force: true })
    throw new InvalidResponseError()
  }
  return size
}
