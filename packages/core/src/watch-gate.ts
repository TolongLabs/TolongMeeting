import type { LinkSource } from './job'
import type { RunLocation } from './types'

export type ChatApp = Extract<LinkSource, { kind: 'chat' }>['app']

/** Where a chat app may be watched from: `allowed` anywhere, `home_only` off the server's own identity, `none` never. */
export interface WatchGate {
  whatsapp: 'allowed' | 'home_only' | 'none'
  discord: 'allowed' | 'home_only'
}

/** The message names the variable and never its value. */
export class WatchGateError extends Error {}

function list(values: readonly string[]): string {
  return values.length < 3 ? values.join(' or ') : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`
}

function choose<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = env[name]
  if (value === undefined) return fallback
  const hit = allowed.find((a) => a === value)
  if (hit === undefined) throw new WatchGateError(`${name} must be ${list(allowed)}`)
  return hit
}

/** Reads `TM_WHATSAPP_FROM_SERVER` (default `home_only`) and `TM_DISCORD_FROM_SERVER` (default `allowed`). */
export function watchGateFromEnv(env: Record<string, string | undefined>): WatchGate {
  return {
    whatsapp: choose(env, 'TM_WHATSAPP_FROM_SERVER', ['allowed', 'home_only', 'none'], 'home_only'),
    discord: choose(env, 'TM_DISCORD_FROM_SERVER', ['allowed', 'home_only'], 'allowed')
  }
}

export function chatWatchAllowed(app: ChatApp, runLocation: RunLocation, gate: WatchGate): boolean {
  if (app === 'teams') return true
  const rule = gate[app]
  if (rule === 'allowed') return true
  if (rule === 'home_only') return runLocation !== 'server'
  return false
}

/** A chat the gate refuses becomes a pasted link, and `blockedApp` says which app was refused. */
export function gateLinkSource(
  link: LinkSource,
  runLocation: RunLocation,
  gate: WatchGate
): { link: LinkSource; blockedApp: ChatApp | null } {
  if (link.kind !== 'chat' || chatWatchAllowed(link.app, runLocation, gate)) return { link, blockedApp: null }
  return { link: { kind: 'paste' }, blockedApp: link.app }
}
