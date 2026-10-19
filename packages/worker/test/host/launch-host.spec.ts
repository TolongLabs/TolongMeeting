// Host-side proof of the Task 7 launch path, for machines without openbox, PulseAudio or the worker image.
// It starts a real Xvfb and the installed Chrome. Run it with:
//   TM_HOST_LAUNCH=1 bunx playwright test -c packages/worker/playwright.config.ts --project=host
// What it cannot show (policy, openbox placement, the audio sink) is covered by test/image/launch.spec.ts.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { launchBrowser, launchGuestStage, openDeskTab } from '../../src/chrome/launch'
import { startScreen } from '../../src/display/screen'
import type { Screen } from '../../src/types'
import { browserCmdline, expectStageFilled, windowBounds } from '../helpers/image'

test.skip(process.env.TM_HOST_LAUNCH !== '1', 'set TM_HOST_LAUNCH=1 (needs Xvfb and google-chrome)')

const DESK = { left: 1920, top: 0, width: 1920, height: 1080 }

const hasOpenbox = spawnSync('which', ['openbox']).status === 0

const xdpyinfoWorks = (display: string) => spawnSync('xdpyinfo', ['-display', display]).status === 0

// A one second 440 Hz mono WAV, so media elements have something to play.
function wavUrl(): string {
  const rate = 8000
  const pcm = Buffer.alloc(rate * 2)
  for (let i = 0; i < rate; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return `data:audio/wav;base64,${Buffer.concat([header, pcm]).toString('base64')}`
}

interface Session {
  screen: Screen
  context: BrowserContext
  stage: Page
  desk: Page
  profileDir: string
}

// A screen and a launched browser, closed again after `body`.
async function withBrowser(body: (s: Session) => Promise<void>, profileDir?: string): Promise<void> {
  const previousDisplay = process.env.DISPLAY
  const dir = profileDir ?? (await mkdtemp(join(tmpdir(), 'tm-profile-')))
  const screen = await startScreen({ windowManager: 'none' })
  try {
    const { context, stage, desk } = await launchBrowser(dir, screen)
    try {
      await body({ screen, context, stage, desk, profileDir: dir })
    } finally {
      await context.close()
    }
  } finally {
    await screen.stop()
    expect(process.env.DISPLAY).toBe(previousDisplay)
    if (!profileDir) await rm(dir, { recursive: true, force: true })
  }
}

// Serves `html` at http://desk.test/<name> to every page of the context (a real navigation, not setContent).
async function serve(context: BrowserContext, pages: Record<string, string>): Promise<void> {
  await context.route('http://desk.test/**', (route) => {
    const body = pages[new URL(route.request().url()).pathname.slice(1)]
    return body === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: 'text/html', body })
  })
}

const autoplayPage = (wav: string) => `<!doctype html><audio id="a" autoplay loop src="${wav}"></audio>`

// Reads the first media element of a page once it is playing.
const mediaState = (page: Page) =>
  page.evaluate(async () => {
    const find = (root: ParentNode): HTMLMediaElement | null => {
      const direct = root.querySelector('audio,video')
      if (direct) return direct
      for (const el of root.querySelectorAll('*')) {
        const inner = el.shadowRoot && find(el.shadowRoot)
        if (inner) return inner
      }
      return null
    }
    const el = find(document) ?? (window as unknown as { __root?: ShadowRoot }).__root?.querySelector('audio') ?? null
    if (!el) throw new Error('no media element in the page')
    for (let i = 0; i < 100 && el.paused; i++) await new Promise((r) => setTimeout(r, 50))
    return { muted: el.muted, volume: el.volume, playing: !el.paused }
  })

test('without openbox, startScreen fails loudly unless the test option allows it', async () => {
  test.skip(hasOpenbox, 'openbox is installed here')
  await expect(startScreen()).rejects.toThrow('cannot start openbox')
})

test('two screens run side by side on different displays and stop independently', async () => {
  const previousDisplay = process.env.DISPLAY
  const [a, b] = await Promise.all([startScreen({ windowManager: 'none' }), startScreen({ windowManager: 'none' })])
  try {
    expect(a.display).not.toBe(b.display)
    expect(xdpyinfoWorks(a.display)).toBe(true)
    expect(xdpyinfoWorks(b.display)).toBe(true)
    expect([a.display, b.display]).toContain(process.env.DISPLAY)
    await a.stop()
    expect(xdpyinfoWorks(a.display)).toBe(false)
    expect(xdpyinfoWorks(b.display)).toBe(true)
    // stop() twice is harmless
    await a.stop()
  } finally {
    await a.stop()
    await b.stop()
  }
  expect(xdpyinfoWorks(b.display)).toBe(false)
  expect(process.env.DISPLAY).toBe(previousDisplay)
})

test('the stage content area is exactly 1920x1080 at the screen origin, with and without the sandbox', async () => {
  test.setTimeout(120_000)
  for (const inImage of [false, true]) {
    const previous = process.env.TM_IN_IMAGE
    if (inImage) process.env.TM_IN_IMAGE = '1'
    try {
      await withBrowser(async ({ screen, context, stage, desk, profileDir }) => {
        expect(screen.stage).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
        expect(screen.desk).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 })
        expect(await windowBounds(context, stage)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
        expect(await windowBounds(context, desk)).toEqual(DESK)
        expect(await stage.evaluate(() => [innerWidth, innerHeight, screenX, screenY, navigator.webdriver])).toEqual([
          1920,
          1080,
          0,
          0,
          false
        ])
        const cmd = browserCmdline(profileDir)
        expect(cmd).not.toContain('--enable-automation')
        expect(cmd).toContain('--app=data:text/html,<title>stage</title>')
        expect(cmd).toContain('--deny-permission-prompts')
        expect(cmd.includes('--no-sandbox')).toBe(inImage)

        await expectStageFilled(stage, screen.display)
      })
    } finally {
      if (previous === undefined) delete process.env.TM_IN_IMAGE
      else process.env.TM_IN_IMAGE = previous
    }
  }
})

test('the profile asks for the system title bar and keeps its other preferences', async () => {
  test.setTimeout(90_000)
  const dir = await mkdtemp(join(tmpdir(), 'tm-profile-'))
  try {
    await mkdir(join(dir, 'Default'))
    await writeFile(
      join(dir, 'Default', 'Preferences'),
      JSON.stringify({ browser: { window_placement: { top: 7 } }, tm_marker: 'kept' })
    )
    await withBrowser(async ({ stage }) => {
      expect(await stage.evaluate(() => innerHeight)).toBe(1080)
    }, dir)
    const prefs = JSON.parse(await readFile(join(dir, 'Default', 'Preferences'), 'utf8'))
    expect(prefs.tm_marker).toBe('kept')
    expect(prefs.browser.custom_chrome_frame).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('every desk page is muted: parser autoplay, shadow roots, navigation, popups, new tabs', async () => {
  test.setTimeout(120_000)
  const wav = wavUrl()
  await withBrowser(async ({ context, stage, desk }) => {
    await serve(context, {
      autoplay: autoplayPage(wav),
      shadow: `<!doctype html><div id="host"></div><script>
        const root = document.getElementById('host').attachShadow({ mode: 'closed' })
        root.innerHTML = '<audio autoplay loop src="${wav}"></audio>'
        window.__root = root</script>`,
      popup: `<!doctype html><button id="b" onclick="window.open('http://desk.test/autoplay', '_blank', 'popup,width=600,height=400')">open</button>`,
      tab: `<!doctype html><button id="b" onclick="window.open('http://desk.test/autoplay')">open</button>`
    })

    // a navigated page: <audio autoplay> inserted by the parser
    await desk.goto('http://desk.test/autoplay')
    expect(await mediaState(desk)).toEqual({ muted: true, volume: 0, playing: true })
    // setters cannot undo it
    expect(
      await desk.evaluate(() => {
        const a = document.getElementById('a') as HTMLAudioElement
        a.muted = false
        a.volume = 1
        return [a.muted, a.volume]
      })
    ).toEqual([true, 0])

    // an element inside a closed shadow root (the page keeps a reference so the test can read it)
    await desk.goto('http://desk.test/shadow')
    expect(await mediaState(desk)).toEqual({ muted: true, volume: 0, playing: true })

    // a window.open popup window from the desk lands on the desk, muted
    await desk.goto('http://desk.test/popup')
    const popupWindow = context.waitForEvent('page')
    await desk.click('#b')
    const popup = await popupWindow
    await popup.waitForLoadState('domcontentloaded')
    expect(await mediaState(popup)).toEqual({ muted: true, volume: 0, playing: true })
    await expect.poll(() => windowBounds(context, popup)).toEqual(DESK)

    // a window.open tab from the desk is muted too
    await desk.goto('http://desk.test/tab')
    const tabPage = context.waitForEvent('page')
    await desk.click('#b')
    const tab = await tabPage
    await tab.waitForLoadState('domcontentloaded')
    expect(await mediaState(tab)).toEqual({ muted: true, volume: 0, playing: true })

    // openDeskTab: a tab in the desk window, muted before it navigates
    const opened = await openDeskTab(context)
    await opened.goto('http://desk.test/autoplay')
    expect(await mediaState(opened)).toEqual({ muted: true, volume: 0, playing: true })
    expect(await windowBounds(context, opened)).toEqual(DESK)

    // a page made with context.newPage() is guarded too
    const plain = await context.newPage()
    await plain.goto('http://desk.test/autoplay')
    expect(await mediaState(plain)).toEqual({ muted: true, volume: 0, playing: true })

    // the stage stays audible: not one patched function, through navigations and a reload
    for (const step of ['goto', 'reload', 'again']) {
      if (step === 'goto') await stage.goto('http://desk.test/autoplay')
      else if (step === 'reload') await stage.reload()
      else await stage.goto('http://desk.test/shadow')
      expect(await mediaState(stage)).toEqual({ muted: false, volume: 1, playing: true })
    }
    expect(await stage.evaluate(() => Symbol.for('tm.deskMuted') in window)).toBe(false)
  })
})

test('desk Web Audio goes through a zero gain and ctx.destination stays the real node', async () => {
  test.setTimeout(90_000)
  // Taps an AnalyserNode behind the silencer (Symbol.for('tm.silencer')) and measures the peak amplitude.
  const measure = (page: Page) =>
    page.evaluate(async () => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const peak = (a: AnalyserNode) => {
        const data = new Float32Array(a.fftSize)
        a.getFloatTimeDomainData(data)
        return Math.max(...data.map(Math.abs))
      }
      const ctx = new AudioContext()
      await ctx.resume()
      const osc = new OscillatorNode(ctx, { frequency: 440 })
      const control = new AnalyserNode(ctx)
      osc.connect(control)
      osc.connect(ctx.destination)
      osc.start()
      const silencer = (ctx as unknown as Record<symbol, GainNode | undefined>)[Symbol.for('tm.silencer')]
      const tap = new AnalyserNode(ctx)
      silencer?.connect(tap)
      await wait(400)
      const result = {
        state: ctx.state,
        control: peak(control),
        hasSilencer: silencer !== undefined,
        silent: silencer ? peak(tap) : null,
        open: null as number | null,
        destination: [
          ctx.destination instanceof AudioDestinationNode,
          ctx.destination.channelCount,
          ctx.destination.maxChannelCount > 0
        ],
        offlineDestination: new OfflineAudioContext(1, 1, 8000).destination instanceof AudioDestinationNode
      }
      if (silencer) {
        // Test only: with the gain at 1 the oscillator must reach the tap, so the zero above is not an empty graph.
        silencer.gain.value = 1
        await wait(400)
        result.open = peak(tap)
      }
      return result
    })
  await withBrowser(async ({ stage, desk }) => {
    const onDesk = await measure(desk)
    expect(onDesk.state).toBe('running')
    expect(onDesk.control).toBeGreaterThan(0.1)
    expect(onDesk.hasSilencer).toBe(true)
    expect(onDesk.silent).toBe(0)
    expect(onDesk.open).toBeGreaterThan(0.1)
    expect(onDesk.destination).toEqual([true, 2, true])
    expect(onDesk.offlineDestination).toBe(true)

    const onStage = await measure(stage)
    expect(onStage.control).toBeGreaterThan(0.1)
    expect(onStage.hasSilencer).toBe(false)
    expect(onStage.destination).toEqual([true, 2, true])
    expect(await stage.evaluate(() => AudioNode.prototype.connect.toString())).toContain('[native code]')
  })
})

test('desk speech does nothing and the stage keeps native speech', async () => {
  test.setTimeout(90_000)
  await withBrowser(async ({ stage, desk }) => {
    const speak = (page: Page) =>
      page.evaluate(async () => {
        const utterance = new SpeechSynthesisUtterance('hello')
        const events: string[] = []
        for (const type of ['start', 'end', 'error']) utterance.addEventListener(type, () => events.push(type))
        const returned = speechSynthesis.speak(utterance)
        await new Promise((r) => setTimeout(r, 500))
        return {
          returned: returned ?? null,
          events,
          native: SpeechSynthesis.prototype.speak.toString().includes('[native code]')
        }
      })
    expect(await speak(desk)).toEqual({ returned: null, events: [], native: false })
    expect((await speak(stage)).native).toBe(true)
  })
})

test('a popup from the stage is closed and logged, and never stays over the stage', async () => {
  test.setTimeout(90_000)
  const logged: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => void logged.push(args.join(' '))
  try {
    await withBrowser(async ({ context, stage, desk }) => {
      await serve(context, { autoplay: autoplayPage(wavUrl()) })
      await stage.setContent(`<button id="b" onclick="window.open('http://desk.test/autoplay')">open</button>`)
      const opened = context.waitForEvent('page')
      await stage.click('#b')
      const popup = await opened
      await expect.poll(() => popup.isClosed()).toBe(true)
      expect(logged.join('\n')).toContain('closed a popup opened by the stage')
      expect(context.pages().filter((p) => !p.isClosed())).toEqual([stage, desk])
      expect(await windowBounds(context, stage)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
    })
  } finally {
    console.error = original
  }
})

test('the guest stage sits on the stage rectangle and cleans up its profile', async () => {
  test.setTimeout(90_000)
  const previousDisplay = process.env.DISPLAY
  // The guest profile goes under TMPDIR: give this test its own, so parallel runs do not see each other's directories.
  const previousTmp = process.env.TMPDIR
  const tmp = await mkdtemp(join(tmpdir(), 'tm-guest-tmp-'))
  process.env.TMPDIR = tmp
  const screen = await startScreen({ windowManager: 'none' })
  try {
    const { browser, stage } = await launchGuestStage(screen)
    const context = stage.context()
    const guestDirs = () => readdirSync(tmp).filter((name) => name.startsWith('tm-guest-'))
    expect(guestDirs()).toHaveLength(1)
    expect(await windowBounds(context, stage)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
    expect(await stage.evaluate(() => [innerWidth, innerHeight, screenX, screenY])).toEqual([1920, 1080, 0, 0])
    await browser.close()
    await expect.poll(guestDirs, { timeout: 10_000 }).toEqual([])
  } finally {
    await screen.stop()
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
    await rm(tmp, { recursive: true, force: true })
    expect(process.env.DISPLAY).toBe(previousDisplay)
  }
})
