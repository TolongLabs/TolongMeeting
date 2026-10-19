import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formIdFor, parseJob, type EventType, type FormCandidate, type JobConfig } from '@tm/core'
import { sendPing, type Ping } from '@tm/notify'
import { createFormPinger, type FormPingRecord } from '../src/forms/pinger'
import { resolveFormLink } from '../src/forms/links'

const PLAIN_FORM = 'https://docs.google.com/forms/d/e/1FAIpQ/viewform'
const FORM = `${PLAIN_FORM}?usp=pp_url&entry.1=x`
const SAFE_LINK = `https://nam01.safelinks.protection.outlook.com/?url=${encodeURIComponent(
  'https://docs.google.com/forms/d/e/1FAIpQ/viewform'
)}&data=05`

let web: Bun.Server<undefined>
let ntfy: Bun.Server<undefined>
let ntfyBodies: Array<Record<string, unknown>>
let dataDir: string
let cfg: JobConfig
let sent: Ping[]
let ev: Array<{ type: EventType; data: Record<string, unknown> }>
let t0: string

// Stands in for the internet: a request for host H, path P is served at /H/P on one local server.
const routed = ((input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input))
  return fetch(`http://127.0.0.1:${web.port}/${u.host}${u.pathname}${u.search}`, init)
}) as typeof fetch

const resolve = (c: FormCandidate) => resolveFormLink(c, { fetch: routed, timeoutMs: 200 })

const send = async (p: Ping): Promise<void> => {
  sent.push(p)
  await sendPing(cfg.ntfy, p)
}

const emit = async (type: EventType, data: Record<string, unknown>): Promise<void> => {
  ev.push({ type, data })
}

async function onlyRecord(): Promise<FormPingRecord> {
  const ids = await readdir(join(dataDir, 'forms'))
  expect(ids).toHaveLength(1)
  return JSON.parse(await readFile(join(dataDir, 'forms', ids[0], 'record.json'), 'utf8'))
}

beforeEach(async () => {
  sent = []
  ev = []
  t0 = new Date().toISOString()
  dataDir = await mkdtemp(join(tmpdir(), 'tm-forms-pinger-'))
  web = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const u = new URL(req.url)
      if (u.pathname === '/forms.gle/abc') return new Response(null, { status: 302, headers: { location: FORM } })
      if (u.pathname.startsWith('/slow.example/')) {
        await Bun.sleep(1000)
        return new Response('late')
      }
      return new Response('not found', { status: 404 })
    }
  })
  ntfyBodies = []
  ntfy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      if (req.headers.get('authorization') !== 'Bearer tok') return new Response('unauthorised', { status: 401 })
      ntfyBodies.push((await req.json()) as Record<string, unknown>)
      return new Response('{}')
    }
  })
  cfg = parseJob({
    occurrenceId: 'occ-1',
    attempt: 1,
    entry: {
      name: 'Data Mining',
      type: 'lecture',
      start: '2026-10-21T14:00:00+08:00',
      end: '2026-10-21T16:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      link: { kind: 'paste' },
      trustedSenders: ['Dr Lecturer'],
      transcription: 'live',
      formDetails: {},
      attendanceKeywords: []
    },
    identity: { id: 'id-1', name: 'Member', zoomGuestName: 'Member', formProviders: ['google'] },
    member: { id: 'm-1', displayName: 'Member', mentionNames: [], details: [] },
    ai: {
      baseUrl: 'https://ai.example/v1',
      apiKey: 'key',
      asrUrl: 'wss://asr.example/ws',
      models: { summary: 's', vision: 'v', formMatch: 'f', asr: 'a' }
    },
    ntfy: { url: `http://127.0.0.1:${ntfy.port}/`, topic: 'tm-test', token: 'tok' },
    dataDir,
    profileDir: join(dataDir, 'profile'),
    control: null
  })
})

afterEach(async () => {
  web.stop(true)
  ntfy.stop(true)
  await rm(dataDir, { recursive: true, force: true })
})

test('trusted QR form: manual-submission ping within 30 s and a record', async () => {
  const p = createFormPinger({ cfg, send, emit, resolve })
  await p.offer({ url: 'https://forms.gle/abc', source: 'qr', sender: null, senderRole: null, seenAt: t0 })
  await p.idle()

  expect(sent.map((s) => s.title)).toEqual(['Form to submit: Data Mining'])
  expect(ntfyBodies.map((b) => b.title)).toEqual(['Form to submit: Data Mining'])
  expect(ntfyBodies[0].priority).toBe(4)
  expect(ntfyBodies[0].actions).toEqual([{ action: 'view', label: 'Open form', url: PLAIN_FORM, clear: false }])

  const rec = await onlyRecord()
  expect(rec).toMatchObject({
    state: 'needs_member',
    trustReason: 'qr_on_screen',
    provider: 'google',
    url: 'https://forms.gle/abc'
  })
  expect(rec.formId).toMatch(/^[0-9a-f]{16}$/)
  expect(rec.formId).toBe(formIdFor(PLAIN_FORM))
  expect(Date.parse(rec.pingedAt!) - Date.parse(rec.seenAt)).toBeLessThan(30_000)
  expect(ev.filter((e) => e.type === 'form').map((e) => e.data.state)).toEqual([
    'resolving',
    'checking_trust',
    'needs_member'
  ])
  expect(JSON.stringify(ev)).not.toContain('?')
})

test('untrusted sender: "seen, not submitted"; one ping per form across shapes', async () => {
  const p = createFormPinger({ cfg, send, emit, resolve })
  for (const url of ['https://forms.gle/abc', FORM, SAFE_LINK]) {
    await p.offer({ url, source: 'meeting_chat', sender: 'Student A', senderRole: 'participant', seenAt: t0 })
  }
  await p.idle()

  expect(sent.map((s) => s.title)).toEqual(['Form seen, not submitted: Data Mining'])
  expect(await onlyRecord()).toMatchObject({ state: 'untrusted', trustReason: null, sender: 'Student A' })
})

test('non-forms are ignored; unresolvable links ping only from trusted sources', async () => {
  const p = createFormPinger({ cfg, send, emit, resolve })
  await p.offer({
    url: 'https://example.com/notes',
    source: 'meeting_chat',
    sender: 'Dr Lecturer',
    senderRole: 'host',
    seenAt: t0
  })
  await p.offer({
    url: 'https://slow.example/a',
    source: 'meeting_chat',
    sender: 'Student A',
    senderRole: 'participant',
    seenAt: t0
  })
  await p.offer({
    url: 'https://slow.example/b',
    source: 'meeting_chat',
    sender: 'Dr Lecturer',
    senderRole: 'host',
    seenAt: t0
  })
  await p.idle()

  expect(sent.map((s) => s.title)).toEqual(['Link seen, not checked: Data Mining'])
  expect(ev.find((e) => e.data.outcome === 'ignored')!.data.host).toBe('example.com')
  expect(ev.find((e) => e.data.outcome === 'unresolved')!.data).toMatchObject({
    reason: 'timeout',
    host: 'slow.example'
  })
  expect(JSON.stringify(ev)).not.toContain('?')
})

test('a failed ping moves the form to failed and emits an error', async () => {
  const failing = async (): Promise<void> => {
    throw new Error('ntfy responded 500')
  }
  const p = createFormPinger({ cfg, send: failing, emit, resolve })
  await p.offer({ url: FORM, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await p.idle()

  expect(await onlyRecord()).toMatchObject({ state: 'failed', pingedAt: null })
  expect(ev.find((e) => e.type === 'error')!.data).toMatchObject({
    where: 'form',
    state: 'failed',
    host: 'docs.google.com',
    message: 'ntfy responded 500'
  })
})

test('a failed ping releases the form: a later sighting of the same form is pinged', async () => {
  let ntfyUp = false
  const flaky = async (p: Ping): Promise<void> => {
    if (!ntfyUp) throw new Error('ntfy responded 500')
    await send(p)
  }
  const p = createFormPinger({ cfg, send: flaky, emit, resolve })
  await p.offer({ url: FORM, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await p.idle()

  expect(sent).toEqual([])
  expect(ev.find((e) => e.type === 'alert')!.data).toMatchObject({ kind: 'form_ping_failed', host: 'docs.google.com' })

  ntfyUp = true
  await p.offer({ url: SAFE_LINK, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await p.idle()

  expect(sent.map((s) => s.title)).toEqual(['Form to submit: Data Mining'])
  expect(await onlyRecord()).toMatchObject({ state: 'needs_member' })
  expect((await onlyRecord()).pingedAt).not.toBeNull()
})

test('a failure after the ping went out keeps the state it was in and never rejects the task', async () => {
  const flakyEvents: typeof emit = async (type, data) => {
    if (type === 'form' && data.state === 'needs_member') throw new Error('event log full')
    ev.push({ type, data })
  }
  const p = createFormPinger({ cfg, send, emit: flakyEvents, resolve })
  await p.offer({ url: 'https://forms.gle/abc', source: 'qr', sender: null, senderRole: null, seenAt: t0 })
  await p.idle()

  expect(sent.map((s) => s.title)).toEqual(['Form to submit: Data Mining'])
  expect(ev.find((e) => e.type === 'error')!.data).toMatchObject({
    state: 'needs_member',
    message: 'event log full'
  })
  expect(ev.some((e) => e.type === 'alert')).toBe(false)
  expect(await onlyRecord()).toMatchObject({ state: 'needs_member' })
  expect((await onlyRecord()).pingedAt).not.toBeNull()
})

test('a candidate that is not a URL is ignored without a rejected task', async () => {
  const p = createFormPinger({ cfg, send, emit, resolve })
  await p.offer({ url: 'not a url at all', source: 'qr', sender: null, senderRole: null, seenAt: t0 })
  await p.idle()

  expect(sent).toEqual([])
  expect(ev).toEqual([{ type: 'form', data: expect.objectContaining({ formId: null, outcome: 'ignored' }) }])
})

test('an untrusted unresolved link is not marked done: a trusted repost is checked and pinged', async () => {
  const p = createFormPinger({ cfg, send, emit, resolve })
  const url = 'https://slow.example/form'
  await p.offer({ url, source: 'meeting_chat', sender: 'Student A', senderRole: 'participant', seenAt: t0 })
  await p.idle()
  expect(sent).toEqual([])

  await p.offer({ url, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await p.idle()

  expect(sent.map((s) => s.title)).toEqual(['Link seen, not checked: Data Mining'])
  expect(ev.filter((e) => e.data.outcome === 'unresolved')).toHaveLength(2)
})

test('ping times are wall-clock in the entry time zone, not the container zone', async () => {
  const p = createFormPinger({ cfg, send, emit, resolve })
  await p.offer({
    url: 'https://forms.gle/abc',
    source: 'qr',
    sender: null,
    senderRole: null,
    seenAt: '2026-10-21T06:30:00.000Z'
  })
  await p.idle()

  expect(sent[0].message).toContain('was seen at 14:30.')
})

test('an emit that throws for error and alert events never rejects the task', async () => {
  const failing = async (): Promise<void> => {
    throw new Error('ntfy responded 500')
  }
  const brokenLog: typeof emit = async (type, data) => {
    if (type === 'error' || type === 'alert') throw new Error('event log full')
    ev.push({ type, data })
  }
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const p = createFormPinger({ cfg, send: failing, emit: brokenLog, resolve })
    await p.offer({ url: FORM, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
    await expect(p.idle()).resolves.toBeUndefined()

    expect(await onlyRecord()).toMatchObject({ state: 'failed', pingedAt: null })
    const lines = errors.mock.calls.map((args) => String(args[0]))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('error not emitted for host=docs.google.com path=/forms/d/e/1FAIpQ/viewform')
    expect(lines[0]).toContain('event log full')
    expect(lines[1]).toContain('alert not emitted for host=docs.google.com')
    expect(lines[1]).toContain('event log full')
    expect(lines.join('\n')).not.toContain('usp=')
  } finally {
    errors.mockRestore()
  }
})

test('a record write that fails right after resolution releases the form', async () => {
  // A plain file where the forms directory belongs makes every record write fail, for real.
  const p = createFormPinger({ cfg, send, emit, resolve })
  await p.ready
  const blocker = join(dataDir, 'forms')
  await writeFile(blocker, 'in the way')
  await p.offer({ url: FORM, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await p.idle()

  expect(sent).toEqual([])
  expect(ev.find((e) => e.type === 'error')!.data).toMatchObject({ where: 'form', state: 'failed' })
  expect(ev.filter((e) => e.type === 'alert').map((e) => e.data)).toEqual([
    expect.objectContaining({ kind: 'form_ping_failed', host: 'docs.google.com' })
  ])

  // The disk recovers: the same raw URL, sent again, is checked and pinged.
  await rm(blocker)
  await p.offer({ url: FORM, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await p.idle()

  expect(sent.map((s) => s.title)).toEqual(['Form to submit: Data Mining'])
  expect(await onlyRecord()).toMatchObject({ state: 'needs_member' })
})

test('a prefilled or direct-submit link pings the plain form, so opening it never submits', async () => {
  const direct = 'https://docs.google.com/forms/d/e/1FAIpQ/formResponse?entry.1=Present&submit=Submit'
  const p = createFormPinger({ cfg, send, emit, resolve })
  await p.offer({ url: direct, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await p.offer({ url: FORM, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await p.idle()

  expect(sent).toHaveLength(1)
  expect(ntfyBodies[0].actions).toEqual([{ action: 'view', label: 'Open form', url: PLAIN_FORM, clear: false }])
  expect(JSON.stringify(ntfyBodies)).not.toMatch(/formResponse|entry\.1|submit=/)
  expect((await onlyRecord()).formId).toBe(formIdFor(PLAIN_FORM))
})

test('a restart does not ping a form whose record shows a ping, or cannot be parsed', async () => {
  const other = 'https://docs.google.com/forms/d/e/1FAOther/viewform'
  const first = createFormPinger({ cfg, send, emit, resolve })
  await first.offer({ url: FORM, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await first.idle()
  expect(sent).toHaveLength(1)
  // A second form whose record an earlier run left unreadable.
  await mkdir(join(dataDir, 'forms', formIdFor(other)), { recursive: true })
  await writeFile(join(dataDir, 'forms', formIdFor(other), 'record.json'), '{"formId": ')

  sent = []
  ev = []
  const direct = async (c: FormCandidate) => ({ ...c, finalUrl: c.url, provider: 'google' as const })
  const fresh = createFormPinger({ cfg, send, emit, resolve: direct })
  for (const url of [FORM, other]) {
    await fresh.offer({ url, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  }
  await fresh.idle()

  expect(sent).toEqual([])
  expect(ev.filter((e) => e.data.outcome === 'ignored').map((e) => [e.data.formId, e.data.reason])).toEqual([
    [formIdFor(PLAIN_FORM), 'already_handled'],
    [formIdFor(other), 'already_handled']
  ])
  expect(await readdir(join(dataDir, 'forms'))).toHaveLength(2)
})

test('a restart pings the form whose record shows no ping went out, and no other', async () => {
  const other = 'https://docs.google.com/forms/d/e/1FAOther/viewform'
  const first = createFormPinger({ cfg, send, emit, resolve })
  await first.offer({ url: FORM, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  await first.idle()
  expect(sent).toHaveLength(1)
  // A form whose ping never went out: its record is valid, failed, and has no pingedAt.
  const unpinged: FormPingRecord = {
    formId: formIdFor(other),
    url: other,
    source: 'meeting_chat',
    sender: 'Dr Lecturer',
    senderRole: 'host',
    seenAt: t0,
    provider: 'google',
    state: 'failed',
    trustReason: null,
    pingedAt: null
  }
  await mkdir(join(dataDir, 'forms', unpinged.formId), { recursive: true })
  await writeFile(join(dataDir, 'forms', unpinged.formId, 'record.json'), JSON.stringify(unpinged))

  sent = []
  ev = []
  const direct = async (c: FormCandidate) => ({ ...c, finalUrl: c.url, provider: 'google' as const })
  const fresh = createFormPinger({ cfg, send, emit, resolve: direct })
  for (const url of [FORM, other]) {
    await fresh.offer({ url, source: 'meeting_chat', sender: 'Dr Lecturer', senderRole: 'host', seenAt: t0 })
  }
  await fresh.idle()

  expect(sent.map((s) => s.title)).toEqual(['Form to submit: Data Mining'])
  expect(ev.filter((e) => e.data.outcome === 'ignored').map((e) => e.data.formId)).toEqual([formIdFor(PLAIN_FORM)])
  const rec = JSON.parse(await readFile(join(dataDir, 'forms', formIdFor(other), 'record.json'), 'utf8'))
  expect(rec).toMatchObject({ state: 'needs_member' })
  expect(rec.pingedAt).not.toBeNull()
})

test('a forms directory that cannot be read rejects ready and fails every offer loudly', async () => {
  await writeFile(join(dataDir, 'forms'), 'not a directory')
  const p = createFormPinger({ cfg, send, emit, resolve })
  const candidate = {
    url: FORM,
    source: 'meeting_chat' as const,
    sender: 'Dr Lecturer',
    senderRole: 'host' as const,
    seenAt: t0
  }

  await expect(p.ready).rejects.toThrow('ENOTDIR')
  await expect(p.offer(candidate)).rejects.toThrow('ENOTDIR')
  await expect(p.offer(candidate)).rejects.toThrow('ENOTDIR')
  await p.idle()

  expect(sent).toEqual([])
  const errors = ev.filter((e) => e.type === 'error')
  expect(errors).toHaveLength(2)
  expect(errors[0].data).toMatchObject({ where: 'form', formId: null })
  expect(String(errors[0].data.message)).toContain('ENOTDIR')
})

const root = process.getuid?.() === 0
const direct = async (c: FormCandidate) => ({ ...c, finalUrl: c.url, provider: 'google' as const })
const candidate = {
  url: FORM,
  source: 'meeting_chat' as const,
  sender: 'Dr Lecturer',
  senderRole: 'host' as const,
  seenAt: '2026-10-21T06:30:00.000Z'
}

test('a restart pings a form whose directory has no record.json', async () => {
  await mkdir(join(dataDir, 'forms', formIdFor(PLAIN_FORM)), { recursive: true })
  const fresh = createFormPinger({ cfg, send, emit, resolve: direct })
  await fresh.offer(candidate)
  await fresh.idle()

  expect(sent.map((s) => s.title)).toEqual(['Form to submit: Data Mining'])
  expect(await onlyRecord()).toMatchObject({ state: 'needs_member' })
  expect((await onlyRecord()).pingedAt).not.toBeNull()
})

test.skipIf(root)('a record that exists but cannot be read rejects ready and every offer', async () => {
  const file = join(dataDir, 'forms', formIdFor(PLAIN_FORM), 'record.json')
  await mkdir(join(dataDir, 'forms', formIdFor(PLAIN_FORM)), { recursive: true })
  await writeFile(file, '{}')
  await chmod(file, 0o000)
  const p = createFormPinger({ cfg, send, emit, resolve })

  await expect(p.ready).rejects.toThrow('EACCES')
  await expect(p.offer(candidate)).rejects.toThrow('EACCES')
  await p.idle()
  expect(sent).toEqual([])
})

test.skipIf(root)('a ping record that cannot be written leaves no record.json and sends nothing', async () => {
  const dir = join(dataDir, 'forms', formIdFor(PLAIN_FORM))
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o555)
  try {
    const p = createFormPinger({ cfg, send, emit, resolve })
    await p.offer(candidate)
    await p.idle()

    expect(sent).toEqual([])
    expect(await readdir(dir)).toEqual([])
    const error = ev.find((e) => e.type === 'error')!
    expect(error.data).toMatchObject({ where: 'form', state: 'failed' })
    expect(String(error.data.message)).toContain('EACCES')
  } finally {
    await chmod(dir, 0o755)
  }
})

test.skipIf(root)('a failed record write keeps the record that was there before', async () => {
  const id = formIdFor(PLAIN_FORM)
  const dir = join(dataDir, 'forms', id)
  const before: FormPingRecord = {
    formId: id,
    url: FORM,
    source: 'meeting_chat',
    sender: 'Dr Lecturer',
    senderRole: 'host',
    seenAt: candidate.seenAt,
    provider: 'google',
    state: 'checking_trust',
    trustReason: null,
    pingedAt: null
  }
  const beforeText = `${JSON.stringify(before, null, 2)}\n`
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'record.json'), beforeText)
  await chmod(dir, 0o555)
  try {
    const p = createFormPinger({ cfg, send, emit, resolve })
    await p.offer(candidate)
    await p.idle()

    expect(sent).toEqual([])
    expect(await readFile(join(dir, 'record.json'), 'utf8')).toBe(beforeText)
    expect(await readdir(dir)).toEqual(['record.json'])
  } finally {
    await chmod(dir, 0o755)
  }
})
