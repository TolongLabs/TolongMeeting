import { deriveKey } from '@tm/core'
import { z } from 'zod'
import { loadMasterKey } from '../db/secrets'
import { scopeHomeNodeStore, type HomeNodeStore } from '../db/home-route'
import { AttemptLimiter } from './companion/tokens'
import type { MemberScope } from './scope'

// The home route (plan 08 task 11): a member's always-on device at home joins the tailnet as an exit node, and their
// server worker leaves through it. This file holds the Tailscale API client, the status check and the two member routes'
// handlers. Request and response shapes follow https://api.tailscale.com/api/v2 (OAuth clients, auth keys, devices).
//
// The OAuth client secret comes from the environment only. It is sent in one token request body, never in a URL, never
// stored per member and never logged: every error here has a fixed message with no response body in it.

const API = 'https://api.tailscale.com'
const REQUEST_TIMEOUT_MS = 10_000
/** A cached token is dropped this long before it expires. */
const TOKEN_MARGIN_MS = 60_000

export const HOME_TAG = 'tag:tm-home'
/** An enrolment key works once and for this long. */
export const ENROL_KEY_SECONDS = 3600

export interface TailscaleConfig {
  clientId: string
  clientSecret: string
  tailnet: string
}

export interface TailscaleDevice {
  nodeId: string
  hostname: string
  addresses: string[]
  tags: string[]
  connectedToControl: boolean
  enabledRoutes: string[]
}

/** A failed Tailscale call. It keeps the HTTP status only: the response body could echo a credential. */
export class TailscaleApiError extends Error {
  readonly status: number | undefined

  constructor(what: string, status?: number) {
    super(status === undefined ? `Tailscale ${what} failed.` : `Tailscale ${what} failed (HTTP ${status}).`)
    this.name = 'TailscaleApiError'
    this.status = status
  }
}

const TokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() })
const KeySchema = z.object({ key: z.string().min(1) })
const DevicesSchema = z.object({
  devices: z.array(
    z.object({
      nodeId: z.string(),
      hostname: z.string(),
      addresses: z.array(z.string()).default([]),
      // Tailscale leaves these out for a device with none.
      tags: z.array(z.string()).default([]),
      connectedToControl: z.boolean().default(false),
      enabledRoutes: z.array(z.string()).default([])
    })
  )
})

/** An auth key lives at most an hour: a leaked or unused key stops working soon. */
const MAX_KEY_SECONDS = 3600

/** Tailscale accepts a key description of at most 50 letters, digits, hyphens and spaces. */
const KEY_DESCRIPTION = /^[A-Za-z0-9 -]{1,50}$/

export class TailscaleApi {
  private token: { value: string; expiresAt: number } | null = null
  private pending: Promise<string> | null = null

  constructor(
    private readonly cfg: TailscaleConfig,
    private readonly f: typeof fetch = fetch
  ) {}

  /** The OAuth access token, fetched once and reused until a minute before it expires. */
  private accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return Promise.resolve(this.token.value)
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async fetchToken(): Promise<string> {
    const res = await this.send('OAuth token request', `${API}/api/v2/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret
      })
    })
    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      // The parse error can quote the response text: keep none of it.
      throw new TailscaleApiError('OAuth token parse')
    }
    const token = TokenSchema.parse(body)
    this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 - TOKEN_MARGIN_MS }
    return token.access_token
  }

  private async send(what: string, url: string, init: RequestInit): Promise<Response> {
    let res: Response
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' })
    } catch {
      // A network error's message can carry the request URL and headers: keep neither.
      throw new TailscaleApiError(what)
    }
    if (!res.ok) throw new TailscaleApiError(what, res.status)
    return res
  }

  private async call(what: string, path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken()
    const res = await this.send(what, `${API}/api/v2/tailnet/${encodeURIComponent(this.cfg.tailnet)}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}`, accept: 'application/json' }
    })
    return res
  }

  /**
   * A single-use, pre-approved auth key for the given tags, valid for `expirySeconds` (at most an hour). The OAuth
   * client must own the tags. The key is returned to the caller and nowhere else.
   */
  async createAuthKey(o: {
    tags: string[]
    ephemeral: boolean
    expirySeconds: number
    description: string
  }): Promise<string> {
    if (o.tags.length === 0 || !o.tags.every((t) => t.startsWith('tag:'))) throw new Error('An auth key needs tags.')
    if (!Number.isInteger(o.expirySeconds) || o.expirySeconds < 1 || o.expirySeconds > MAX_KEY_SECONDS)
      throw new Error('An auth key lives at most one hour.')
    if (!KEY_DESCRIPTION.test(o.description)) throw new Error('The auth key description is not allowed.')
    const res = await this.call('auth key creation', '/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilities: {
          devices: { create: { reusable: false, ephemeral: o.ephemeral, preauthorized: true, tags: o.tags } }
        },
        expirySeconds: o.expirySeconds,
        description: o.description
      })
    })
    return KeySchema.parse(await res.json()).key
  }

  /** Every device in the tailnet, with `enabledRoutes` (the default field set leaves it out). */
  async devices(): Promise<TailscaleDevice[]> {
    const res = await this.call('device list', '/devices?fields=all')
    return DevicesSchema.parse(await res.json()).devices.map((d) => ({
      nodeId: d.nodeId,
      hostname: d.hostname,
      addresses: d.addresses,
      tags: d.tags,
      connectedToControl: d.connectedToControl,
      enabledRoutes: d.enabledRoutes
    }))
  }
}

export type HomeRouteStatus = 'ready' | 'offline' | 'not_exit_node' | 'not_enrolled'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The machine name the member's home device must register with: `tm-home-` and 24 hex characters of a keyed hash of the
 * member id, derived from the master key. Only this server can compute it, so another member can't register a device
 * under it by guessing (the member id is not secret, so a name made from it, such as its first 8 characters, would be
 * guessable). The name is still chosen by the device. That is why `checkHomeRoute` also pins the node id.
 */
export function homeHostname(master: Buffer, memberId: string): string {
  if (!UUID.test(memberId)) throw new Error('Not a member id.')
  return `tm-home-${deriveKey(master, `home-hostname:${memberId.toLowerCase()}`).toString('hex').slice(0, 24)}`
}

/** A single-use key (valid for an hour) for the member's home device, and the hostname it must register with. */
export async function enrolKey(
  api: TailscaleApi,
  master: Buffer,
  memberId: string
): Promise<{ key: string; hostname: string }> {
  const hostname = homeHostname(master, memberId)
  // Not ephemeral, on purpose: the home device is a long-lived exit node, and an ephemeral node is deleted by Tailscale
  // soon after it goes offline (a reboot or a router restart), which would break the member's route. The sidecar's
  // worker-side key (plan 08 task 13) stays ephemeral. The key is still single-use, tagged, pre-approved and short-lived.
  const key = await api.createAuthKey({
    tags: [HOME_TAG],
    ephemeral: false,
    expirySeconds: ENROL_KEY_SECONDS,
    description: `tm-home ${memberId.slice(0, 8).toLowerCase()}`
  })
  return { key, hostname }
}

const EXIT_ROUTES = ['0.0.0.0/0', '::/0']
const statusOf = (d: TailscaleDevice): HomeRouteStatus =>
  !d.connectedToControl ? 'offline' : EXIT_ROUTES.every((r) => d.enabledRoutes.includes(r)) ? 'ready' : 'not_exit_node'

/**
 * Looks the member's device up in the tailnet on every call. A device counts only if it carries `tag:tm-home`, has the
 * member's keyed hostname (`homeHostname`) and, once a node is stored for the member, is that very node: a later device
 * with the same name never replaces a stored one while it exists. Tailscale does not say which auth key created a node,
 * so these three checks are what binds a node to its member. Another member's device, an untagged one or a lookalike
 * never counts. A ready device is stored with its IPv4 address. A stored node that is missing or has lost its tag is
 * `offline` and stays stored (no other device is adopted in its place; the member's setup flow re-pins). Two unpinned
 * devices with the name are not trusted. Throws `TailscaleApiError` when Tailscale can't be reached.
 */
export async function checkHomeRoute(
  store: HomeNodeStore,
  api: TailscaleApi,
  master: Buffer,
  memberId: string,
  now: Date = new Date()
): Promise<{ status: HomeRouteStatus; hostname: string; ipv4: string | null }> {
  const hostname = homeHostname(master, memberId)
  const named = (await api.devices()).filter((d) => d.tags.includes(HOME_TAG) && d.hostname === hostname)
  const pinned = await store.get()
  // A pinned node that is missing or has lost its tag is offline. The pin stays: only the member's setup flow re-pins.
  const mine = pinned ? named.find((d) => d.nodeId === pinned.nodeId) : named.length === 1 ? named[0] : undefined
  if (!mine) return { status: pinned ? 'offline' : 'not_enrolled', hostname, ipv4: null }
  const status = statusOf(mine)
  if (status !== 'ready') return { status, hostname, ipv4: null }
  const ipv4 = mine.addresses.find((a) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(a))
  if (!ipv4) throw new Error('A ready home device has no IPv4 address.')
  await store.save({ nodeId: mine.nodeId, hostname, ipv4, checkedAt: now })
  return { status: 'ready', hostname, ipv4 }
}

// ---------------------------------------------------------------------------------------------------------------------
// Member routes

export interface HomeRouteDeps {
  api: TailscaleApi
  /** The master key the home hostnames are derived from. */
  master: Buffer
  /** Setup keys issued per member. */
  keyLimiter: AttemptLimiter
  /** Checks per member. */
  checkLimiter: AttemptLimiter
  now(): Date
}

export const MAX_KEYS_PER_HOUR = 5
export const MAX_CHECKS_PER_10_MIN = 30

/** `null` unless `TM_TAILSCALE_CLIENT_ID` and `TM_TAILSCALE_CLIENT_SECRET` are both set. */
export function tailscaleConfigFromEnv(env: Record<string, string | undefined> = process.env): TailscaleConfig | null {
  const clientId = env.TM_TAILSCALE_CLIENT_ID
  const clientSecret = env.TM_TAILSCALE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, tailnet: env.TM_TAILSCALE_TAILNET || '-' }
}

// One client (and its token cache) and one pair of limiters per process; Next.js reloads modules in development.
const shared = globalThis as typeof globalThis & { __tmHomeRoute?: HomeRouteDeps }

/** What the routes run on, or `null` when the Tailscale OAuth client is not configured. */
export function homeRouteDeps(env: Record<string, string | undefined> = process.env): HomeRouteDeps | null {
  const cfg = tailscaleConfigFromEnv(env)
  if (!cfg) return null
  shared.__tmHomeRoute ??= {
    api: new TailscaleApi(cfg),
    master: loadMasterKey(env.TM_MASTER_KEY_FILE),
    keyLimiter: new AttemptLimiter(MAX_KEYS_PER_HOUR, 3_600_000),
    checkLimiter: new AttemptLimiter(MAX_CHECKS_PER_10_MIN, 600_000),
    now: () => new Date()
  }
  return shared.__tmHomeRoute
}

const NO_STORE = { 'cache-control': 'no-store' }
const fail = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE })

/** Browsers say where a request came from; a member route accepts only the site's own pages (and non-browser clients). */
const crossSite = (request: Request): boolean => {
  const site = request.headers.get('sec-fetch-site')
  return site !== null && site !== 'same-origin'
}

/** Runs a Tailscale call; a Tailscale failure is the same 502 whatever its cause. */
async function viaTailscale(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof TailscaleApiError || e instanceof z.ZodError) return fail('tailscale_unavailable', 502)
    throw e
  }
}

/**
 * `POST /api/home-route/key` for the signed-in member: a single-use setup key and the hostname to register with. The
 * key is in this one response and is never stored. 503 when the OAuth client is not configured, 429 after 5 keys an hour.
 */
export async function handleKeyRequest(
  request: Request,
  scope: MemberScope,
  deps: HomeRouteDeps | null
): Promise<Response> {
  if (crossSite(request)) return fail('forbidden', 403)
  if (!deps) return fail('home_route_unavailable', 503)
  const now = deps.now()
  if (deps.keyLimiter.locked(scope.memberId, now)) return fail('too_many_keys', 429)
  // Counted before the call, so a failing Tailscale can't be hammered through this route either.
  deps.keyLimiter.fail(scope.memberId, now)
  return viaTailscale(async () =>
    Response.json(await enrolKey(deps.api, deps.master, scope.memberId), { headers: NO_STORE })
  )
}

/** `POST /api/home-route/check` for the signed-in member: `{ status, hostname }`. */
export async function handleCheckRequest(
  request: Request,
  scope: MemberScope,
  deps: HomeRouteDeps | null
): Promise<Response> {
  if (crossSite(request)) return fail('forbidden', 403)
  if (!deps) return fail('home_route_unavailable', 503)
  const now = deps.now()
  if (deps.checkLimiter.locked(scope.memberId, now)) return fail('too_many_checks', 429)
  deps.checkLimiter.fail(scope.memberId, now)
  return viaTailscale(async () => {
    const { status, hostname } = await checkHomeRoute(
      scopeHomeNodeStore(scope),
      deps.api,
      deps.master,
      scope.memberId,
      now
    )
    return Response.json({ status, hostname }, { headers: NO_STORE })
  })
}
