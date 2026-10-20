import { expect, test } from 'bun:test'
import { CHAT_HOST, watcherFor } from '../../src/watchers'
import * as discord from '../../src/watchers/discord'
import * as teams from '../../src/watchers/teams'
import * as whatsapp from '../../src/watchers/whatsapp'

test('each chat app has its watcher', () => {
  expect(watcherFor('discord')).toBe(discord.startWatcher)
  expect(watcherFor('whatsapp')).toBe(whatsapp.startWatcher)
  expect(watcherFor('teams')).toBe(teams.startWatcher)
})

test('each chat app has the hosts its watcher tab can live on', () => {
  expect(CHAT_HOST).toEqual({
    discord: ['discord.com'],
    whatsapp: ['web.whatsapp.com'],
    teams: ['teams.microsoft.com', 'teams.live.com']
  })
})
