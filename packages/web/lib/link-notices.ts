import { chatWatchAllowed, type ChatApp, type LinkSource, type RunLocation, type WatchGate } from '@tm/core'

export const BAN_RISK_NOTICE =
  "WhatsApp and Discord don't allow automated use of personal accounts. The bot only reads this chat: it opens it, checks it every 12 to 45 seconds, and never sends, reacts or replies. That lowers the risk of your account being restricted or banned, but doesn't remove it. If that risk isn't acceptable, use a fixed link or paste the link instead."

export const TRUSTED_SENDERS_CHAT_HINT =
  "For a watched chat, enter each sender as the chat shows them: in WhatsApp, their saved contact name, or their phone number if you haven't saved it."

export const CHAT_FIELD_COPY: Record<'whatsapp' | 'discord', { label: string; placeholder: string; hint: string }> = {
  whatsapp: {
    label: 'WhatsApp chat name',
    placeholder: 'Class group name',
    hint: 'Type the name exactly as WhatsApp shows it, including capitals and emoji. Only one of your chats may have this name.'
  },
  discord: {
    label: 'Discord channel address',
    placeholder: 'https://discord.com/channels/<server>/<channel>',
    hint: 'Open the channel in Discord in a browser and copy the address bar.'
  }
}

const APP_NAME = { whatsapp: 'WhatsApp', discord: 'Discord', teams: 'Teams' } as const

/** The notice shows for chat sources on WhatsApp or Discord. */
export function showsBanRiskNotice(link: LinkSource): boolean {
  return link.kind === 'chat' && (link.app === 'whatsapp' || link.app === 'discord')
}

/** Why `gate` refuses `app`: it runs only at home or on the member's PC, or it is switched off. */
export function watchingNotAllowedMessage(app: ChatApp, gate: WatchGate): string {
  if (app === 'teams') throw new Error('Teams watching is never refused by the gate')
  if (gate[app] === 'none') return `${APP_NAME[app]} watching is switched off. Choose another link source.`
  return `${APP_NAME[app]} is watched only for identities that run at home or on your PC. Change where this identity runs, or choose another link source.`
}

export class WatchingNotAllowedError extends Error {
  constructor(app: ChatApp, gate: WatchGate) {
    super(watchingNotAllowedMessage(app, gate))
    this.name = 'WatchingNotAllowedError'
  }
}

/** The chat apps the entry form offers for an identity: a refused app is disabled and says why in `note`. */
export function chatAppOptions(
  runLocation: RunLocation,
  gate: WatchGate
): { app: 'whatsapp' | 'discord'; enabled: boolean; note: string | null }[] {
  return (['whatsapp', 'discord'] as const).map((app) => {
    const enabled = chatWatchAllowed(app, runLocation, gate)
    return { app, enabled, note: enabled ? null : watchingNotAllowedMessage(app, gate) }
  })
}
