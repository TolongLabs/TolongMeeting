import { expect, test } from 'bun:test'
import { chromeArgs } from '../src/chrome/launch'
import type { Screen } from '../src/types'

const fakeScreen: Screen = {
  display: ':99',
  width: 3840,
  height: 1080,
  stage: { x: 0, y: 0, width: 1920, height: 1080 },
  desk: { x: 1920, y: 0, width: 1920, height: 1080 },
  stop: async () => {}
}

test('chrome flags from the design', () => {
  const a = chromeArgs(fakeScreen)
  for (const f of [
    '--app=data:text/html,<title>stage</title>',
    '--window-position=0,0',
    '--window-size=1920,1080',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--password-store=basic',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--deny-permission-prompts',
    '--no-first-run',
    '--no-default-browser-check'
  ])
    expect(a).toContain(f)
  expect(a).not.toContain('--enable-automation')
  expect(a).not.toContain('--test-type')
})
