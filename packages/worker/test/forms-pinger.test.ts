import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJob, type EventType, type FormCandidate, type JobConfig } from '@tm/core'
import { sendPing, type Ping } from '@tm/notify'
import { createFormPinger, type FormPingRecord } from '../src/forms/pinger'
import { resolveFormLink } from '../src/forms/links'

const FORM = 'https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=pp_url&entry.1=x'
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
  expect(ntfyBodies[0].actions).toEqual([{ action: 'view', label: 'Open form', url: FORM, clear: false }])

  const rec = await onlyRecord()
  expect(rec).toMatchObject({
    state: 'needs_member',
    trustReason: 'qr_on_screen',
    provider: 'google',
    url: 'https://forms.gle/abc'
  })
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
    host: 'docs.google.com'
  })
})
