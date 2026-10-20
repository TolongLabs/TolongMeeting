import { expect, test } from 'bun:test'
import type { Page } from 'playwright'
import { DeskPause } from '../src/control/desk-pause'
import { makeFormContextBase } from '../src/forms/context'
import { makeCfg } from './helpers/fake-deps'

// A desk pause that starts and stops at once; the forms only see `whenOpen` and `nextResume`.
const pause = () =>
  new DeskPause({
    startVnc: async () => ({ stop: async () => undefined }),
    idleMs: async () => 0,
    openTabs: async () => async () => undefined,
    anchor: async () => undefined,
    checkpoint: async () => undefined,
    emit: () => undefined
  })

const tab = {} as Page

async function context(p: DeskPause | null) {
  return makeFormContextBase(
    await makeCfg('lecture'),
    tab,
    async () => undefined,
    undefined,
    async () => undefined,
    p
  )
}

test('form work on the desk waits while the member holds it', async () => {
  const p = pause()
  const ctx = await context(p)
  await p.pause()
  let released = false
  const waiting = ctx.deskOpen!().then(() => (released = true))
  await Bun.sleep(1)
  expect(released).toBe(false)
  await p.resume('command')
  await waiting
  expect(released).toBe(true)
})

test('a form that hit the sign-in wall is released by the member pressing Done', async () => {
  const p = pause()
  const ctx = await context(p)
  await p.pause()
  const signedIn = ctx.waitForSignin(tab, 'google', new AbortController().signal)
  await p.resume('command')
  expect(await signedIn).toBe(true)
})

test('a form waiting for the sign-in stops waiting when the meeting ends', async () => {
  const p = pause()
  const ctx = await context(p)
  const abort = new AbortController()
  const signedIn = ctx.waitForSignin(tab, 'google', abort.signal)
  abort.abort()
  expect(await signedIn).toBe(false)
  expect(await ctx.waitForSignin(tab, 'google', abort.signal)).toBe(false)
})

test('without a desk pause the desk is always free', async () => {
  const ctx = await context(null)
  expect(ctx.deskOpen).toBeUndefined()
})

test('a pause requested during a slow fill starts only after the fill, and no driver call runs while paused', async () => {
  const p = pause()
  const ctx = await context(p)
  const log: string[] = []
  let finishFill: () => void = () => undefined
  const fill = ctx.deskStep(
    () =>
      new Promise<void>((resolve) => {
        log.push('fill starts')
        finishFill = () => {
          log.push(`fill ends, paused: ${p.paused}`)
          resolve()
        }
      })
  )
  const paused = p.pause()
  await Bun.sleep(1)
  expect(p.paused).toBe(false)
  finishFill()
  await fill
  await paused
  expect(p.paused).toBe(true)
  let nextRan = false
  const next = ctx.deskStep(async () => void (nextRan = true))
  await Bun.sleep(1)
  expect(nextRan).toBe(false)
  await p.resume('command')
  await next
  expect(nextRan).toBe(true)
  expect(log).toEqual(['fill starts', 'fill ends, paused: false'])
})

test('without a desk pause a driver step runs at once', async () => {
  const ctx = await context(null)
  expect(await ctx.deskStep(async () => 'done')).toBe('done')
})
