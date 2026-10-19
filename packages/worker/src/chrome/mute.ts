import type { Page } from 'playwright'

// Runs inside the page, before its own scripts. It must not reference anything outside its own body.
function deskMuteScript(): void {
  const mark = Symbol.for('tm.deskMuted')
  const w = window as unknown as Record<symbol, unknown>
  if (w[mark]) return
  w[mark] = true

  // Media elements: muted is forced on at play time, on load and whenever the element is attached.
  const media = HTMLMediaElement.prototype
  const mutedDesc = Object.getOwnPropertyDescriptor(media, 'muted')!
  const setMuted = (el: HTMLMediaElement) => mutedDesc.set!.call(el, true)
  Object.defineProperty(media, 'muted', {
    configurable: true,
    enumerable: true,
    get(this: HTMLMediaElement) {
      return mutedDesc.get!.call(this)
    },
    set(this: HTMLMediaElement) {
      setMuted(this)
    }
  })
  const play = media.play
  media.play = function (this: HTMLMediaElement) {
    setMuted(this)
    return play.call(this)
  }
  for (const type of ['loadstart', 'play', 'playing', 'volumechange']) {
    document.addEventListener(type, (event) => event.target instanceof HTMLMediaElement && setMuted(event.target), true)
  }

  // Web Audio: every AudioContext destination becomes a zero gain node wired to the real destination.
  const destDesc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination')!
  const silenced = new WeakMap<BaseAudioContext, GainNode>()
  Object.defineProperty(BaseAudioContext.prototype, 'destination', {
    configurable: true,
    enumerable: true,
    get(this: BaseAudioContext) {
      const real = destDesc.get!.call(this) as AudioDestinationNode
      if (this instanceof OfflineAudioContext) return real
      let gain = silenced.get(this)
      if (!gain) {
        gain = this.createGain()
        gain.gain.value = 0
        gain.connect(real)
        silenced.set(this, gain)
      }
      return gain
    }
  })
}

// Mutes every tab of the desk: call it for each desk page. Applies to the current document and to every later one.
export async function muteDesk(page: Page): Promise<void> {
  await page.addInitScript(deskMuteScript)
  await page.evaluate(deskMuteScript)
}
