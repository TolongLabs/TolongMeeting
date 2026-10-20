import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { basename, extname, join, resolve } from 'node:path'
import type { Pki } from './pki'

const FIXTURES = resolve(import.meta.dirname, '../../fixtures')
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

type ScriptEvent =
  | { t: 'chat'; sender: string; time: string; text: string }
  | { t: 'share'; slide: string }
  | { t: 'stopShare' }
  | { t: 'end' }
  | { t: 'remove' }

// Runs in the meeting page (the fixture's zoom-meeting-top.html, inside its iframe): it plays the clip on the stage and
// applies the events the test scripts, the way the Zoom server would push them.
const MEETING_SCRIPT = `<script>
(() => {
  const video = document.createElement('video')
  Object.assign(video, { src: '/__e2e/stage.webm', autoplay: true, loop: true, playsInline: true })
  Object.assign(video.style, { position: 'fixed', left: '1420px', top: '700px', width: '170px', height: '96px', zIndex: 1 })
  video.id = 'e2e-stage-video'
  document.body.append(video)
  const share = async (slide) => {
    let canvas = document.querySelector('#sharee-container canvas')
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.width = 1410
      canvas.height = 840
      document.getElementById('sharee-container').append(canvas)
    }
    const img = new Image()
    img.src = '/__e2e/slide/' + slide + '.png'
    await img.decode()
    canvas.getContext('2d').drawImage(img, 0, 0, 1410, 840)
  }
  const apply = (e) => {
    if (e.t === 'chat') window.__fixture.addMessage({ sender: e.sender, time: e.time, text: e.text })
    else if (e.t === 'share') share(e.slide)
    else if (e.t === 'stopShare') window.__fixture.stopShare()
    else if (e.t === 'end') window.__fixture.endMeeting()
    else if (e.t === 'remove') window.__fixture.remove()
  }
  let since = 0
  setInterval(async () => {
    const body = await (await fetch('/__e2e/events?since=' + since)).json()
    since = body.next
    body.events.forEach(apply)
  }, 300)
})()
</script>`

// Runs in the waiting-room page: the host admits the bot (or refuses it) when the test says so.
const LOBBY_SCRIPT = `<script>
(() => {
  const status = document.getElementById('status')
  setInterval(async () => {
    const state = await (await fetch('/__e2e/state')).json()
    if (state.lobby === 'admitted') location.href = 'zoom-meeting-iframe.html?seed=0'
    if (state.lobby === 'denied') status.textContent = 'You have been removed from the waiting room'
  }, 300)
})()
</script>`

export interface FakeZoom {
  /** The port Chrome's host-resolver rule sends every *.zoom.us name to. */
  port: number
  /** Every request path (no query) the server answered, in order. */
  requests: string[]
  /** How many times a client opened the pre-join page. */
  joinPageLoads(): number
  admit(): void
  deny(): void
  chat(sender: string, text: string): void
  share(slide: Buffer): void
  stopShare(): void
  end(): void
  remove(): void
  close(): Promise<void>
}

// A stand-in for Zoom's web client built from the repository's fixtures (pre-join, waiting room, meeting in an
// iframe), served over TLS. The pre-join page always leads to the waiting room; the host's script decides what follows.
export async function startFakeZoom(pki: Pki, clip: Buffer): Promise<FakeZoom> {
  const events: ScriptEvent[] = []
  const slides = new Map<string, Buffer>()
  const requests: string[] = []
  let lobby: 'waiting' | 'admitted' | 'denied' = 'waiting'
  let joinLoads = 0
  let chats = 0

  const fixture = (name: string): string | null => {
    if (!/^[\w.-]+\.(html|js)$/.test(name)) return null
    try {
      return readFileSync(join(FIXTURES, name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  const server: Server = createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://zoom.us')
    requests.push(url.pathname)
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra }).end(body)
    const json = (value: unknown) => send(200, 'application/json', JSON.stringify(value))

    if (url.pathname === '/__e2e/state') return json({ lobby })
    if (url.pathname === '/__e2e/events') {
      const since = Number(url.searchParams.get('since') ?? 0)
      return json({ events: events.slice(since), next: events.length })
    }
    if (url.pathname === '/__e2e/stage.webm') return send(200, 'video/webm', clip)
    const slide = /^\/__e2e\/slide\/([\w-]+)\.png$/.exec(url.pathname)?.[1]
    if (slide !== undefined) {
      const png = slides.get(slide)
      return png ? send(200, 'image/png', png) : send(404, 'text/plain', 'no such slide')
    }
    if (/^\/wc\/join\/\d+$/.test(url.pathname)) {
      joinLoads += 1
      // The fixture reads where to go next from its query: here it always goes to the waiting room, and the guest name
      // is typed by the worker (the pre-join page starts with an empty name).
      const page = fixture('zoom-prejoin.html')!.replace("params.get('then')", "'lobby'")
      return send(200, TYPES['.html']!, page)
    }
    const name = basename(url.pathname)
    const file = fixture(name)
    if (file === null) return send(404, 'text/plain', 'not found')
    let body = file
    if (name === 'zoom-lobby.html') body = file.replace('</body>', `${LOBBY_SCRIPT}</body>`)
    if (name === 'zoom-meeting-top.html') body = file.replace('</body>', `${MEETING_SCRIPT}</body>`)
    return send(200, TYPES[extname(name)]!, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const push = (e: ScriptEvent): void => void events.push(e)
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    joinPageLoads: () => joinLoads,
    admit: () => void (lobby = 'admitted'),
    deny: () => void (lobby = 'denied'),
    chat(sender, text) {
      chats += 1
      push({ t: 'chat', sender, text, time: `8:${String(40 + chats).padStart(2, '0')} PM` })
    },
    share(png) {
      const slide = `s${slides.size + 1}`
      slides.set(slide, png)
      push({ t: 'share', slide })
    },
    stopShare: () => push({ t: 'stopShare' }),
    end: () => push({ t: 'end' }),
    remove: () => push({ t: 'remove' }),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  }
}
