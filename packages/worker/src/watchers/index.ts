import type { ChatApp } from '@tm/core'
import * as discord from './discord'
import * as teams from './teams'
import * as whatsapp from './whatsapp'

export type StartWatcher = typeof discord.startWatcher

/** The watcher for a chat app. */
export function watcherFor(app: ChatApp): StartWatcher {
  switch (app) {
    case 'discord':
      return discord.startWatcher
    case 'whatsapp':
      return whatsapp.startWatcher
    case 'teams':
      return teams.startWatcher
  }
}

/** The host each chat app's watcher tab lives on. The sign-in pause must not open a second tab on it. */
export const CHAT_HOST: Record<ChatApp, string> = {
  discord: 'discord.com',
  whatsapp: 'web.whatsapp.com',
  teams: 'teams.microsoft.com'
}
