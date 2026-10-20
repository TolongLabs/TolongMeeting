import { describe, expect, test } from 'bun:test'
import { buildTrayMenu, type TrayActions } from '../src/main/tray-menu'

function actions(calls: string[]): TrayActions {
  return {
    openSummaries: () => void calls.push('summaries'),
    openSettings: () => void calls.push('settings'),
    openPairing: () => void calls.push('pairing'),
    signIn: (id) => void calls.push(`signin:${id}`),
    quit: () => void calls.push('quit')
  }
}
const labels = (items: { label?: string; type?: string }[]) => items.map((i) => i.label ?? i.type)

describe('tray menu', () => {
  test('holds a disabled status line, the summaries folder, settings and quit, in that order', () => {
    const items = buildTrayMenu({ status: 'connected', identities: [] }, actions([]))
    expect(labels(items)).toEqual(['Connected', 'Open summaries folder', 'Settings', 'separator', 'Quit TolongMeeting'])
    expect(items[0]!.enabled).toBe(false)
    expect(items.slice(1).every((i) => i.enabled !== false)).toBe(true)
  })

  test('the status line says Connected, Offline or Not paired', () => {
    for (const [status, label] of [
      ['connected', 'Connected'],
      ['offline', 'Offline'],
      ['not_paired', 'Not paired']
    ] as const) {
      expect(buildTrayMenu({ status, identities: [] }, actions([]))[0]!.label).toBe(label)
    }
  })

  test('each item runs its action', () => {
    const calls: string[] = []
    const items = buildTrayMenu({ status: 'connected', identities: [] }, actions(calls))
    for (const item of items) (item.click as (() => void) | undefined)?.()
    expect(calls).toEqual(['summaries', 'settings', 'quit'])
  })

  test('a paired PC gets one sign-in item per local identity, between Settings and Quit', () => {
    const calls: string[] = []
    const items = buildTrayMenu(
      {
        status: 'offline',
        identities: [
          { id: 'u1', name: 'University' },
          { id: 'u2', name: 'Work' }
        ]
      },
      actions(calls)
    )
    expect(labels(items)).toEqual([
      'Offline',
      'Open summaries folder',
      'Settings',
      'Sign in to University',
      'Sign in to Work',
      'separator',
      'Quit TolongMeeting'
    ])
    ;(items[4]!.click as () => void)()
    expect(calls).toEqual(['signin:u2'])
  })

  test('an unpaired PC offers Pair this PC and no sign-in items', () => {
    const calls: string[] = []
    const items = buildTrayMenu(
      { status: 'not_paired', identities: [{ id: 'u1', name: 'University' }] },
      actions(calls)
    )
    expect(labels(items)).toEqual([
      'Not paired',
      'Open summaries folder',
      'Settings',
      'Pair this PC',
      'separator',
      'Quit TolongMeeting'
    ])
    ;(items[3]!.click as () => void)()
    expect(calls).toEqual(['pairing'])
  })

  test('an identity name is shown as text: no keyboard-shortcut marker, no long line', () => {
    const items = buildTrayMenu(
      { status: 'connected', identities: [{ id: 'u1', name: `R&D ${'x'.repeat(100)}` }] },
      actions([])
    )
    const label = items[3]!.label!
    expect(label.startsWith('Sign in to R&&D ')).toBe(true)
    expect(label.length).toBeLessThan(90)
    expect(label.endsWith('…')).toBe(true)
  })
})
