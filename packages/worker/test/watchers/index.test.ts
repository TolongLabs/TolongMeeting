import { expect, test } from 'bun:test'
import { CHAT_HOST, watcherFor } from '../../src/watchers'
import * as discord from '../../src/watchers/discord'
import * as whatsapp from '../../src/watchers/whatsapp'

test('each chat app has its watcher; Teams arrives with plan 04', () => {
  expect(watcherFor('discord')).toBe(discord.startWatcher)
  expect(watcherFor('whatsapp')).toBe(whatsapp.startWatcher)
  expect(watcherFor('teams')).toBeNull()
})

test('each chat app has the host its watcher tab lives on', () => {
  expect(CHAT_HOST).toEqual({
    discord: 'discord.com',
    whatsapp: 'web.whatsapp.com',
    teams: 'teams.microsoft.com'
  })
})
