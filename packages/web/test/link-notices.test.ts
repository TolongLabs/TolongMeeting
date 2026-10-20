import { expect, test } from 'bun:test'
import {
  BAN_RISK_NOTICE,
  CHAT_FIELD_COPY,
  chatAppOptions,
  showsBanRiskNotice,
  signinNotes,
  watchingNotAllowedMessage,
  WatchingNotAllowedError
} from '../lib/link-notices'

test('the ban-risk notice shows for WhatsApp and Discord only', () => {
  expect(showsBanRiskNotice({ kind: 'chat', app: 'whatsapp', chat: 'Class group' })).toBe(true)
  expect(
    showsBanRiskNotice({ kind: 'chat', app: 'discord', chat: 'https://discord.com/channels/@me/234567890123456789' })
  ).toBe(true)
  expect(showsBanRiskNotice({ kind: 'chat', app: 'teams', chat: 'https://teams.microsoft.com/l/chat/x' })).toBe(false)
  expect(showsBanRiskNotice({ kind: 'paste' })).toBe(false)
  expect(showsBanRiskNotice({ kind: 'fixed', url: 'https://example.zoom.us/j/00000000000' })).toBe(false)
  expect(BAN_RISK_NOTICE).toStartWith("WhatsApp and Discord don't allow automated use of personal accounts.")
  expect(BAN_RISK_NOTICE).toContain('never sends, reacts or replies')
})

test('app options follow the gate and the run location', () => {
  expect(chatAppOptions('server', { whatsapp: 'home_only', discord: 'allowed' })).toEqual([
    {
      app: 'whatsapp',
      enabled: false,
      note: 'WhatsApp is watched only for accounts that run at home or on your PC. Change where this account runs, or choose another link source.'
    },
    { app: 'discord', enabled: true, note: null }
  ])
  expect(chatAppOptions('local', { whatsapp: 'home_only', discord: 'allowed' })[0]!.enabled).toBe(true)
  expect(
    chatAppOptions('server_via_home', { whatsapp: 'home_only', discord: 'home_only' }).map((o) => o.enabled)
  ).toEqual([true, true])
  expect(chatAppOptions('local', { whatsapp: 'none', discord: 'allowed' })[0]!.note).toBe(
    'WhatsApp watching is switched off. Choose another link source.'
  )
})

test('a refusal carries the gate message', () => {
  const gate = { whatsapp: 'home_only', discord: 'home_only' } as const
  expect(watchingNotAllowedMessage('discord', gate)).toStartWith('Discord is watched only for accounts')
  const error = new WatchingNotAllowedError('whatsapp', gate)
  expect(error.message).toBe(watchingNotAllowedMessage('whatsapp', gate))
  expect(error).toBeInstanceOf(Error)
})

test('the chat field copy names each app', () => {
  expect(CHAT_FIELD_COPY.whatsapp.label).toBe('WhatsApp chat name')
  expect(CHAT_FIELD_COPY.discord.placeholder).toBe('https://discord.com/channels/<server>/<channel>')
})

test('sign-in notes follow the gate', () => {
  const home = { whatsapp: 'home_only', discord: 'allowed' } as const
  expect(signinNotes('server', home).whatsapp).toStartWith("Don't link WhatsApp here")
  expect(signinNotes('local', home).whatsapp).toStartWith('WhatsApp Web: on your phone')
  expect(signinNotes('server', { whatsapp: 'none', discord: 'home_only' })).toEqual({
    whatsapp: "WhatsApp watching is switched off, so there's no need to link it.",
    discord:
      "Don't sign in to Discord here: this account runs on the server, and Discord is watched only for accounts that run at home or on your PC."
  })
  expect(signinNotes('local', { whatsapp: 'none', discord: 'home_only' }).whatsapp).toBe(
    "WhatsApp watching is switched off, so there's no need to link it."
  )
  expect(signinNotes('server', { whatsapp: 'allowed', discord: 'allowed' }).discord).toStartWith(
    'Discord: sign in at discord.com'
  )
})
