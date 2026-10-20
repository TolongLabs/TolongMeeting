const DISCORD_HOSTS = new Set([
  'discord.com',
  'www.discord.com',
  'ptb.discord.com',
  'canary.discord.com',
  'discordapp.com'
])
// /channels/<server or @me>/<channel>, optionally followed by a message id.
const CHANNEL_PATH = /^\/channels\/(@me|\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/
const CONTROL_CHARACTERS = /\p{Cc}/u

/**
 * Turns a Discord channel link into `https://discord.com/channels/<server>/<channel>`, or null. The message id, query
 * and fragment are dropped. Only https on the default port, with no userinfo, on a known Discord host is accepted.
 */
export function normaliseDiscordChannelUrl(url: string): string | null {
  const trimmed = url.trim()
  // The URL parser silently strips tabs and newlines, so refuse control characters first.
  if (CONTROL_CHARACTERS.test(trimmed) || !URL.canParse(trimmed)) return null
  const u = new URL(trimmed)
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null
  if (!DISCORD_HOSTS.has(u.hostname)) return null
  const match = CHANNEL_PATH.exec(u.pathname)
  if (!match) return null
  return `https://discord.com/channels/${match[1]}/${match[2]}`
}
