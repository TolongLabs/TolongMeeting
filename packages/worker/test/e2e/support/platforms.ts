import type { Page } from '@playwright/test'
import { meetForbiddenClicks, serveMeet, setMeetScene } from '../../meet/serve'
import { serveTeams, setTeamsScene, teamsForbiddenClicks } from '../../teams/serve'
import type { Running } from './harness'

// The lecturer's name on the Teams and Meet rosters, and the other students on them (the participant count is 12).
export const ORGANISER = 'Dr Example'
export const STUDENT = 'Test Student'
export const PARTICIPANTS = 12

/** A meeting on a platform other than Zoom, played on the repository's imitation pages (Playwright routes). */
export interface Meeting {
  platform: 'teams' | 'meet'
  /** The entry's fixed link. */
  link: string
  /** Another link of the same meeting that the organiser posts in the chat. */
  chatLink: string
  host: string
  /** What the member's pings, events, console output and the AI service's input must never hold. */
  secrets: string[]
  /** The join links' host: it must not reach the AI service either. */
  linkHost: string
  /** Pass as `onBrowser`: serves the pre-join pages on the stage page, ending in the waiting room. */
  prepare(r: Running): Promise<void>
  /** The organiser lets the bot in. */
  admit(r: Running): Promise<void>
  chat(r: Running, sender: string, text: string): Promise<void>
  /** A participant joins the roster (the People list). */
  person(r: Running, name: string, organiser?: boolean): Promise<void>
  share(r: Running, slide: Buffer): Promise<void>
  stopShare(r: Running): Promise<void>
  end(r: Running): Promise<void>
  /** Labels of the clicks the page counted on a control the bot must never use. */
  forbiddenClicks(r: Running): Promise<string[]>
}

const SHARE_BOX = { x: 20, y: 70, width: 1500, height: 900 }
const SLIDE = { width: 1410, height: 840 }

// Runs in the page: paints the slide into the shared-screen element now and every 300 ms, so a re-render of the page
// (the imitations rebuild their markup on many clicks) shows it again at once.
async function paintSlide(page: Page, png: Buffer, mode: 'canvas' | 'stream'): Promise<void> {
  await page.evaluate(
    async ({ dataUrl, mode, size }) => {
      const w = window as unknown as { __tmSlide?: number }
      if (w.__tmSlide !== undefined) clearInterval(w.__tmSlide)
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const paint = (): void => {
        if (mode === 'canvas') {
          const c = document.querySelector<HTMLCanvasElement>("[data-stream-type='ScreenSharing'] canvas")
          c?.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
          return
        }
        const v = document.querySelector<HTMLVideoElement>("[data-is-presentation='true'] video")
        if (v === null) return
        const holder = v as unknown as { __tmCanvas?: HTMLCanvasElement }
        if (holder.__tmCanvas === undefined) {
          holder.__tmCanvas = Object.assign(document.createElement('canvas'), size)
          v.srcObject = holder.__tmCanvas.captureStream(10)
        }
        holder.__tmCanvas.getContext('2d')!.drawImage(img, 0, 0, size.width, size.height)
      }
      paint()
      w.__tmSlide = window.setInterval(paint, 300)
    },
    { dataUrl: `data:image/png;base64,${png.toString('base64')}`, mode, size: SLIDE }
  )
}

const stopPainting = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as unknown as { __tmSlide?: number }
    if (w.__tmSlide !== undefined) clearInterval(w.__tmSlide)
  })

const stamp = (n: number): { time: string; datetime: string } => ({
  time: `8:${String(40 + n).padStart(2, '0')} PM`,
  datetime: new Date().toISOString()
})

type TeamsWindow = { __addMessage(m: object): void; __addRoster(p: object): void }
type MeetWindow = { __addMessage(m: object): void; __addPerson(p: object): void }

export function teamsMeeting(): Meeting {
  let messages = 0
  return {
    platform: 'teams',
    link: 'https://teams.microsoft.com/meet/9876543210123?p=TEAMSPASS77',
    chatLink: 'https://teams.microsoft.com/meet/9876543210123?p=TEAMSCHATPASS88',
    host: ORGANISER,
    secrets: ['TEAMSPASS77', 'TEAMSCHATPASS88', 'p=TEAMS', '9876543210123'],
    linkHost: 'teams.microsoft.com',
    prepare: (r) => serveTeams(r.stage, { scene: 'launcher', afterLauncher: 'prejoin', afterJoin: 'lobby' }),
    admit: (r) =>
      setTeamsScene(r.stage, 'meeting', {
        chatOpen: true,
        peopleCount: PARTICIPANTS,
        roster: [{ name: ORGANISER, role: 'Organizer' }, { name: STUDENT }]
      }),
    chat: (r, sender, text) =>
      r.stage.evaluate(
        ([m]) => (window as unknown as TeamsWindow).__addMessage(m!),
        [{ id: `t${++messages}`, sender, text, ...stamp(messages) }]
      ),
    person: (r, name, organiser = false) =>
      r.stage.evaluate(
        ([p]) => (window as unknown as TeamsWindow).__addRoster(p!),
        [organiser ? { name, role: 'Organizer' } : { name }]
      ),
    share: async (r, slide) => {
      await setTeamsScene(r.stage, 'meeting', { share: { box: SHARE_BOX, ...SLIDE } })
      await paintSlide(r.stage, slide, 'canvas')
    },
    stopShare: async (r) => {
      await stopPainting(r.stage)
      await setTeamsScene(r.stage, 'meeting', { share: null })
    },
    end: (r) => setTeamsScene(r.stage, 'ended'),
    forbiddenClicks: (r) => teamsForbiddenClicks(r.stage)
  }
}

export function meetMeeting(): Meeting {
  let messages = 0
  return {
    platform: 'meet',
    link: 'https://meet.google.com/abc-defg-hij',
    chatLink: 'https://meet.google.com/lookup/e2e-class-room',
    host: ORGANISER,
    secrets: ['abc-defg-hij', 'e2e-class-room'],
    linkHost: 'meet.google.com',
    prepare: (r) => serveMeet(r.stage, { scene: 'prejoin', joinAs: 'ask' }),
    admit: (r) =>
      setMeetScene(r.stage, 'meeting', {
        sidePanel: 'chat',
        peopleCount: PARTICIPANTS,
        people: [{ name: ORGANISER, label: 'Meeting host' }, { name: STUDENT }]
      }),
    chat: (r, sender, text) =>
      r.stage.evaluate(
        ([m]) => (window as unknown as MeetWindow).__addMessage(m!),
        [{ id: `g${++messages}`, sender, text, time: stamp(messages).time }]
      ),
    person: (r, name, organiser = false) =>
      r.stage.evaluate(
        ([p]) => (window as unknown as MeetWindow).__addPerson(p!),
        [organiser ? { name, label: 'Meeting host' } : { name }]
      ),
    share: async (r, slide) => {
      await setMeetScene(r.stage, 'meeting', { share: { box: SHARE_BOX, ...SLIDE } })
      await paintSlide(r.stage, slide, 'stream')
    },
    stopShare: async (r) => {
      await stopPainting(r.stage)
      await setMeetScene(r.stage, 'meeting', { share: null })
    },
    end: (r) => setMeetScene(r.stage, 'ended'),
    forbiddenClicks: (r) => meetForbiddenClicks(r.stage)
  }
}
