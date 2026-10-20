import { expect, test } from 'bun:test'
import { chatWatchAllowed, gateLinkSource, watchGateFromEnv, type WatchGate } from '../src'

test('the gate defaults to WhatsApp at home only and Discord everywhere', () => {
  expect(watchGateFromEnv({})).toEqual({
    whatsapp: 'home_only',
    discord: 'allowed'
  })
  expect(
    watchGateFromEnv({
      TM_WHATSAPP_FROM_SERVER: 'none',
      TM_DISCORD_FROM_SERVER: 'home_only'
    })
  ).toEqual({ whatsapp: 'none', discord: 'home_only' })
  expect(() => watchGateFromEnv({ TM_DISCORD_FROM_SERVER: 'none' })).toThrow(
    'TM_DISCORD_FROM_SERVER must be allowed or home_only'
  )
})

test('a bad gate value is named but never echoed', () => {
  expect(() => watchGateFromEnv({ TM_WHATSAPP_FROM_SERVER: 'hunter2' })).toThrow(
    'TM_WHATSAPP_FROM_SERVER must be allowed, home_only or none'
  )
  expect(() => watchGateFromEnv({ TM_WHATSAPP_FROM_SERVER: 'hunter2' })).not.toThrow('hunter2')
})

test('an empty gate value is an error, not the default', () => {
  expect(() => watchGateFromEnv({ TM_WHATSAPP_FROM_SERVER: '' })).toThrow(
    'TM_WHATSAPP_FROM_SERVER must be allowed, home_only or none'
  )
  expect(() => watchGateFromEnv({ TM_DISCORD_FROM_SERVER: '' })).toThrow(
    'TM_DISCORD_FROM_SERVER must be allowed or home_only'
  )
})

test('home_only refuses only server identities; none refuses all', () => {
  const g: WatchGate = { whatsapp: 'home_only', discord: 'allowed' }
  expect(chatWatchAllowed('whatsapp', 'server', g)).toBe(false)
  expect(chatWatchAllowed('whatsapp', 'server_via_home', g)).toBe(true)
  expect(chatWatchAllowed('whatsapp', 'local', g)).toBe(true)
  expect(chatWatchAllowed('discord', 'server', g)).toBe(true)
  expect(chatWatchAllowed('whatsapp', 'local', { ...g, whatsapp: 'none' })).toBe(false)
  expect(
    chatWatchAllowed('teams', 'server', {
      whatsapp: 'none',
      discord: 'home_only'
    })
  ).toBe(true)
})

test('a refused chat becomes a pasted link', () => {
  const g: WatchGate = { whatsapp: 'home_only', discord: 'allowed' }
  expect(gateLinkSource({ kind: 'chat', app: 'whatsapp', chat: 'Class group' }, 'server', g)).toEqual({
    link: { kind: 'paste' },
    blockedApp: 'whatsapp'
  })
  const fixed = {
    kind: 'fixed',
    url: 'https://example.zoom.us/j/00000000000'
  } as const
  expect(gateLinkSource(fixed, 'server', g)).toEqual({
    link: fixed,
    blockedApp: null
  })
})
