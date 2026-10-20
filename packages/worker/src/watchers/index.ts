import type { ChatApp } from '@tm/core'
import * as discord from './discord'
import * as whatsapp from './whatsapp'

export type StartWatcher = typeof discord.startWatcher

/** The watcher for a chat app; null where there is none yet (Teams arrives with plan 04). */
export function watcherFor(app: ChatApp): StartWatcher | null {
  switch (app) {
    case 'discord':
      return discord.startWatcher
    case 'whatsapp':
      return whatsapp.startWatcher
    case 'teams':
      return null
  }
}

/** The host each chat app's watcher tab lives on. The sign-in pause must not open a second tab on it. */
export const CHAT_HOST: Record<ChatApp, string> = {
  discord: 'discord.com',
  whatsapp: 'web.whatsapp.com',
  teams: 'teams.microsoft.com'
}
