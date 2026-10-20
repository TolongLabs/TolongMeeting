import { createServer as createHttp, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { createServer as createHttps } from 'node:https'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Pki } from './pki'

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const listen = (server: HttpServer): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

const closeServer = (server: HttpServer): Promise<void> => {
  server.closeAllConnections()
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
}

// --- ntfy ---

export interface SeenPing {
  title: string
  message: string
  priority: number
  /** The `view` actions' targets. */
  actionUrls: string[]
  attachment: boolean
  /** When the stub took the request (Date.now()). */
  at: number
  /** The whole request as it came: headers and body, for searches. */
  raw: string
}

export interface NtfyStub {
  url: string
  pings: SeenPing[]
  /** Pings whose title starts with `prefix`. */
  titled(prefix: string): SeenPing[]
  close(): Promise<void>
}

// Records every publish, JSON or attachment (a PUT to /<topic>), and answers 200.
export async function startNtfyStub(): Promise<NtfyStub> {
  const pings: SeenPing[] = []
  const server = createHttp(async (req, res) => {
    const body = await readBody(req)
    const headers = JSON.stringify(req.headers)
    if (req.method === 'PUT') {
      const actions = String(req.headers.actions ?? '')
      pings.push({
        title: String(req.headers.title ?? ''),
        message: String(req.headers.message ?? ''),
        priority: Number(req.headers.priority ?? 0),
        actionUrls: actions === '' ? [] : actions.split(';').map((a) => a.split(',').slice(2).join(',').trim()),
        attachment: true,
        at: Date.now(),
        raw: `${headers}\n(${body.length} bytes attached)`
      })
    } else {
      const json = JSON.parse(body.toString('utf8')) as {
        title: string
        message: string
        priority: number
        actions?: { url: string }[]
      }
      pings.push({
        title: json.title,
        message: json.message,
        priority: json.priority,
        actionUrls: (json.actions ?? []).map((a) => a.url),
        attachment: false,
        at: Date.now(),
        raw: `${headers}\n${body.toString('utf8')}`
      })
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"x"}')
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    pings,
    titled: (prefix) => pings.filter((p) => p.title.startsWith(prefix)),
    close: () => closeServer(server)
  }
}

// --- the OpenAI-compatible model ---

export const MODELS = { summary: 'e2e-summary', vision: 'e2e-vision', formMatch: 'e2e-form-match', asr: 'e2e-asr' }

export interface AiStub {
  url: string
  /** Every chat request: the model and the whole body as text. */
  requests: { model: string; body: string }[]
  close(): Promise<void>
}

const DETAIL_FOR_LABEL: [RegExp, string][] = [
  [/programme/i, 'programme'],
  [/full name/i, 'full_name'],
  [/matric|student id/i, 'student_id'],
  [/course code/i, 'course_code']
]

// What the three models answer. Each reply is fixed by the model's name; the form matcher reads the labels it is sent.
export const SUMMARY_REPLY = {
  sessionLabel: 'Week 5',
  nextAction: 'Submit the quiz by 2026-11-02.',
  items: [
    {
      kind: 'deadline',
      text: 'Quiz 2 is due',
      due: '2026-11-02',
      source: 'slide',
      ref: 'slide 1',
      conflicts: []
    },
    // A reply a prompt injection could have written: it must not reach the summary.
    {
      kind: 'link',
      text: 'Join again at https://e2e.zoom.us/j/81234567890?pwd=CHATPWD999',
      due: null,
      source: 'lecturer_chat',
      ref: null,
      conflicts: []
    }
  ],
  covered: ['Why attendance forms are shown as codes']
}

export async function startAiStub(): Promise<AiStub> {
  const requests: AiStub['requests'] = []
  const server = createHttp(async (req, res) => {
    const text = (await readBody(req)).toString('utf8')
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end()
    const body = JSON.parse(text) as { model: string; messages: { role: string; content: unknown }[] }
    requests.push({ model: body.model, body: text })
    let reply: unknown
    if (body.model === MODELS.formMatch) {
      const user = body.messages.find((m) => m.role === 'user')!
      const { questions } = JSON.parse(user.content as string) as { questions: { id: string; label: string }[] }
      reply = {
        matches: questions.map((q) => ({
          question: q.id,
          detail: DETAIL_FOR_LABEL.find(([pattern]) => pattern.test(q.label))?.[1] ?? null,
          confidence: 'high'
        }))
      }
    } else if (body.model === MODELS.vision) {
      reply = { title: 'Week 5 attendance', text: 'Quiz 2 is due on 2 November 2026. Scan the code to register.' }
    } else if (body.model === MODELS.summary) {
      reply = SUMMARY_REPLY
    } else {
      return void res.writeHead(400).end(`unknown model ${body.model}`)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }))
  })
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => closeServer(server) }
}

// --- realtime ASR ---

export const TRANSCRIPT_LINES = [
  'Good evening everyone, welcome to week five.',
  'Please scan the code on the slide to register your attendance.',
  'The second quiz is due on the second of November.',
  'We will look at decision trees next.'
]

export interface AsrStub {
  /** wss:// URL for the job. */
  url: string
  /** How many sockets opened, and how many bytes of audio arrived in all. */
  sockets(): number
  audioBytes(): number
  /** The next speech turn the stub reports says this instead of the next fixed line (queued in order). */
  say(text: string): void
  close(): Promise<void>
}

const BYTES_PER_SECOND = 32_000

// Speaks the DashScope realtime protocol far enough for the worker: it confirms the session, and for every 3 seconds of
// audio it hears it reports one speech turn with the next fixed line.
export async function startAsrStub(pki: Pki): Promise<AsrStub> {
  const server = createHttps({ key: pki.key, cert: pki.cert })
  const wss = new WebSocketServer({ server })
  let sockets = 0
  let audioBytes = 0
  let line = 0
  const said: string[] = []
  wss.on('connection', (ws: WebSocket) => {
    sockets += 1
    let heard = 0
    let sinceTurn = 0
    const send = (value: Record<string, unknown>) => ws.send(JSON.stringify(value))
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; audio?: string }
      if (msg.type === 'session.update') return send({ type: 'session.updated' })
      if (msg.type === 'session.finish') return send({ type: 'session.finished' })
      if (msg.type !== 'input_audio_buffer.append') return
      const bytes = Buffer.from(msg.audio ?? '', 'base64').length
      audioBytes += bytes
      heard += bytes
      sinceTurn += bytes
      if (sinceTurn < 3 * BYTES_PER_SECOND) return
      const itemId = `item_${heard}`
      const endMs = (heard / BYTES_PER_SECOND) * 1000
      send({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: endMs - 2500 })
      send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: endMs })
      send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: itemId,
        transcript: said.shift() ?? TRANSCRIPT_LINES[line++ % TRANSCRIPT_LINES.length]
      })
      sinceTurn = 0
    })
  })
  const port = await listen(server)
  return {
    url: `wss://localhost:${port}/realtime`,
    sockets: () => sockets,
    audioBytes: () => audioBytes,
    say: (text) => void said.push(text),
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await closeServer(server)
    }
  }
}

// --- the control channel (the website's heartbeat endpoint) ---

export interface ControlStub {
  /** `http://127.0.0.1:<port>`: the job's `control.url`. */
  url: string
  token: string
  /** Every heartbeat body the worker sent, in order. */
  beats: {
    state: string
    recording: boolean
    linkUsed?: string
    events: { type: string; at: string; data: Record<string, unknown> }[]
  }[]
  /** The states the beats carried, in order, one entry per change. */
  states(): string[]
  /** Queued for the answer to the next heartbeat. */
  command(...commands: string[]): void
  close(): Promise<void>
}

// Takes every heartbeat (it checks the token), acknowledges all its events, and answers with the commands queued so far.
export async function startControlStub(token = 'ctl-e2e-token'): Promise<ControlStub> {
  const beats: ControlStub['beats'] = []
  const queued: string[] = []
  const server = createHttp(async (req, res) => {
    const body = await readBody(req)
    if (req.method !== 'POST' || req.url !== '/heartbeat') return void res.writeHead(404).end()
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end()
    const beat = JSON.parse(body.toString('utf8')) as ControlStub['beats'][number]
    beats.push(beat)
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ackedEvents: beat.events.length, commands: queued.splice(0), link: null }))
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    beats,
    states: () => beats.map((b) => b.state).filter((s, i, all) => i === 0 || s !== all[i - 1]),
    command: (...commands) => void queued.push(...commands),
    close: () => closeServer(server)
  }
}
