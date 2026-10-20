import type { BrowserContext, Page } from 'playwright'

// Runs inside the page, before its own scripts. It must not reference anything outside its own body.
//
// Media elements are muted (muted = true, volume = 0) before they can play: when created, when inserted (also inside
// shadow roots), on play(), on every setter that can start playback, and again on any volume change that bypasses
// the patched setters (native controls). Web Audio connections to the speakers go through a zero gain node while
// ctx.destination stays the real destination object. speechSynthesis.speak does nothing.
function deskMuteScript(): void {
  // A window can outlive its document: the initial about:blank of a popup keeps its window object when a same-origin
  // navigation replaces the document, and then Chrome does not run init scripts again. So the patches below go on once
  // per window, window-level capture listeners see media events of every later document, and DOMContentLoaded starts
  // observing the new document. A second run in the same window (an explicit muteDesk) only observes the document.
  const mark = Symbol.for('tm.deskMuted')
  const w = window as unknown as Record<symbol, (() => void) | undefined>
  const installed = w[mark]
  if (installed) return installed()

  // --- Media elements ---
  const media = HTMLMediaElement.prototype
  const mutedDesc = Object.getOwnPropertyDescriptor(media, 'muted')!
  const volumeDesc = Object.getOwnPropertyDescriptor(media, 'volume')!
  const nativePlay = media.play
  const nativeLoad = media.load
  const seen = new WeakSet<HTMLMediaElement>()

  const silence = (el: HTMLMediaElement): void => {
    mutedDesc.set!.call(el, true)
    volumeDesc.set!.call(el, 0)
    el.defaultMuted = true
    if (seen.has(el)) return
    seen.add(el)
    for (const type of ['loadstart', 'play', 'playing', 'volumechange'])
      el.addEventListener(type, () => silence(el), true)
  }

  Object.defineProperty(media, 'muted', {
    configurable: true,
    enumerable: true,
    get: mutedDesc.get,
    set(this: HTMLMediaElement) {
      silence(this)
    }
  })
  Object.defineProperty(media, 'volume', {
    configurable: true,
    enumerable: true,
    get: volumeDesc.get,
    set(this: HTMLMediaElement) {
      silence(this)
    }
  })
  media.play = function (this: HTMLMediaElement) {
    silence(this)
    return nativePlay.call(this)
  }
  media.load = function (this: HTMLMediaElement) {
    silence(this)
    return nativeLoad.call(this)
  }
  for (const name of ['src', 'srcObject', 'autoplay'] as const) {
    const desc = Object.getOwnPropertyDescriptor(media, name)!
    Object.defineProperty(media, name, {
      configurable: true,
      enumerable: true,
      get: desc.get,
      set(this: HTMLMediaElement, value: unknown) {
        silence(this)
        desc.set!.call(this, value)
      }
    })
  }

  const createElement = Document.prototype.createElement
  Document.prototype.createElement = function (this: Document, ...args: Parameters<Document['createElement']>) {
    const el = createElement.apply(this, args)
    if (el instanceof HTMLMediaElement) silence(el)
    return el
  } as typeof createElement
  window.Audio = new Proxy(window.Audio, {
    construct(target, args, newTarget) {
      const el = Reflect.construct(target, args, newTarget) as HTMLAudioElement
      silence(el)
      return el
    }
  })

  // Elements the parser or a script inserts, including those inside shadow roots (open or closed), whose events do not
  // reach the document. The observer starts at document_start, before the parser inserts anything.
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) visit(node)
  })
  const visit = (el: Element): void => {
    const all = [el, ...el.querySelectorAll('*')]
    for (const e of all) {
      if (e instanceof HTMLMediaElement) silence(e)
      if (e.shadowRoot) adopt(e.shadowRoot)
    }
  }
  const adopt = (root: ShadowRoot): void => {
    observer.observe(root, { childList: true, subtree: true })
    for (const child of root.children) visit(child)
  }
  const watchDocument = (): void => {
    observer.observe(document, { childList: true, subtree: true })
    if (document.documentElement) visit(document.documentElement)
  }
  w[mark] = watchDocument
  for (const type of ['loadstart', 'loadedmetadata', 'play', 'playing', 'volumechange'])
    window.addEventListener(type, (event) => event.target instanceof HTMLMediaElement && silence(event.target), true)
  window.addEventListener('DOMContentLoaded', watchDocument, true)
  const attachShadow = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init)
    adopt(root)
    return root
  }
  watchDocument()

  // --- Speech ---
  if (typeof SpeechSynthesis !== 'undefined') SpeechSynthesis.prototype.speak = function () {}

  // --- Web Audio ---
  // A connection to the real (hardware) destination goes to a zero gain node that feeds the real destination.
  // ctx.destination is untouched, so reads of channelCount and maxChannelCount still work. Offline contexts never reach
  // a speaker and stay as they are. The gain node is also stored on the context under Symbol.for('tm.silencer').
  const nativeConnect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown
  const nativeDisconnect = AudioNode.prototype.disconnect as (this: AudioNode, ...args: unknown[]) => unknown
  const silencers = new WeakMap<BaseAudioContext, GainNode>()
  const isSpeaker = (node: unknown): node is AudioDestinationNode =>
    node instanceof AudioDestinationNode && !(node.context instanceof OfflineAudioContext)
  const silencerFor = (speaker: AudioDestinationNode): GainNode => {
    let gain = silencers.get(speaker.context)
    if (!gain) {
      gain = new GainNode(speaker.context, { gain: 0 })
      nativeConnect.call(gain, speaker)
      silencers.set(speaker.context, gain)
      Object.defineProperty(speaker.context, Symbol.for('tm.silencer'), { value: gain })
    }
    return gain
  }
  AudioNode.prototype.connect = function (this: AudioNode, target: unknown, ...rest: unknown[]) {
    if (!isSpeaker(target)) return nativeConnect.call(this, target, ...rest)
    nativeConnect.call(this, silencerFor(target), ...rest)
    return target
  } as typeof AudioNode.prototype.connect
  AudioNode.prototype.disconnect = function (this: AudioNode, target?: unknown, ...rest: unknown[]) {
    if (!isSpeaker(target))
      return target === undefined ? nativeDisconnect.call(this) : nativeDisconnect.call(this, target, ...rest)
    return nativeDisconnect.call(this, silencerFor(target), ...rest)
  } as typeof AudioNode.prototype.disconnect
}

// Mutes every desk page from its first script on, with no gap between the page's creation and the mute: a context init
// script runs in every new document before the page's own scripts, popups included. The rule is that the stage's audio
// is never muted, so the script installs only where the document reports display-mode "browser": a desk window or tab.
// The stage is an app window (standalone), and an HTML fullscreen document, or a cross-origin iframe inside the stage,
// reports standalone or fullscreen, so the script never touches them. A desk page that reports anything else is still
// muted by the unconditional page-level mute that guardPage applies. launchBrowser checks that the stage reports
// standalone.
export async function muteDeskContext(context: BrowserContext): Promise<void> {
  await context.addInitScript({
    content: `if (matchMedia('(display-mode: browser)').matches) (${deskMuteScript.toString()})()`
  })
}

// Mutes one desk page, current document and every later one. launchBrowser's page handler and openDeskTab call it for
// every desk page; muteDeskContext already covers the page from its first script on.
export async function muteDesk(page: Page): Promise<void> {
  await page.addInitScript(deskMuteScript)
  await page.evaluate(deskMuteScript)
}
