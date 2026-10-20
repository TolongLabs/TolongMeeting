import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JobConfig, SpecEnv } from '@tm/core'
import type { HomeNode } from '@tm/web/db/home-route'
import type { TailscaleApi } from '@tm/web/lib/home-route'
import {
  authKeyPath,
  buildSidecarBody,
  resolveEnv,
  sidecarName,
  HOME_ROUTE_IMAGE,
  type SidecarBody
} from '../container-spec'
import { DockerError, type DockerClient } from '../docker'
import { HomeRouteUnavailable } from './types'

export { HOME_ROUTE_IMAGE, sidecarName }
export { HomeRouteUnavailable }

/** The tag the Tailscale policy gives to a server-run worker's node: it may reach `autogroup:internet` and nothing else. */
const WORKER_TAG = 'tag:tm-worker'
/** The sidecar's auth key works once and for this long. */
const KEY_SECONDS = 600
const STOP_TIMEOUT_S = 5

/** `sidecarName` with the body the gate expects; see `buildSidecarBody` for what is in it. */
export function sidecarCreateBody(o: {
  occurrenceId: string
  identityId: string
  node: Pick<HomeNode, 'nodeId' | 'hostname'>
  tailscaleVersion: string
  env: SpecEnv
}): SidecarBody {
  const { hosts } = resolveEnv(o.env)
  return buildSidecarBody({
    occurrenceId: o.occurrenceId,
    identityId: o.identityId,
    exitNodeId: o.node.nodeId,
    exitNodeHostname: o.node.hostname,
    tailscaleVersion: o.tailscaleVersion,
    profileRoot: o.env.profileRoot,
    hosts
  })
}

/** What `launchViaHome` needs. `launchWorker` starts the worker inside the sidecar's namespace; false: it failed to start. */
export type SidecarDeps = {
  api: Pick<TailscaleApi, 'createAuthKey'>
  docker: Pick<DockerClient, 'create' | 'start' | 'stop' | 'remove' | 'inspect'>
  env: SpecEnv
  tailscaleVersion: string
  launchWorker(cfg: JobConfig, via: { sidecar: string }): Promise<boolean>
  /** How long the tunnel may take to come up. Default 60000. */
  healthTimeoutMs?: number
  /** How often to look. Default 1000. */
  pollMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Stops and removes the sidecar of an occurrence, whatever state it is in. A sidecar that is already gone is fine; Docker
 * failures other than "gone" are thrown. `AutoRemove` removes a stopped one, so a remove is sent only for one that
 * exists and is not running (created and never started).
 */
export async function removeSidecar(docker: Pick<DockerClient, 'stop' | 'remove' | 'inspect'>, occurrenceId: string) {
  const name = sidecarName(occurrenceId)
  const state = await docker.inspect(name)
  if (state === null) return
  try {
    if (state.running) await docker.stop(name, STOP_TIMEOUT_S)
    const after = await docker.inspect(name)
    if (after !== null && !after.running) await docker.remove(name)
  } catch (e) {
    // 404: gone already. 409: `AutoRemove` is removing it.
    if (!(e instanceof DockerError && (e.status === 404 || e.status === 409))) throw e
  }
}

/** Writes the one-time auth key where the sidecar's key mount points. The directory is private to the scheduler. */
async function writeKeyFile(path: string, key: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await rm(path, { force: true })
  const file = await open(path, 'wx', 0o444)
  try {
    await file.writeFile(`${key}\n`)
    // The sidecar runs as root without DAC_OVERRIDE, so it needs the "other" read bit; the directory keeps it private.
    await file.chmod(0o444)
  } finally {
    await file.close()
  }
}

/**
 * Starts the member's tunnel and then the worker behind it:
 *
 * 1. a healthy sidecar of this occurrence is reused (a restart); any other one is removed;
 * 2. an ephemeral, single-use worker key (tag `tag:tm-worker`, 10 minutes) goes into a file that the sidecar mounts
 *    read-only; it is in no environment variable or argument, and the file is deleted as soon as the sidecar is up or the
 *    launch fails;
 * 3. the sidecar is created and started with the member's stored node id and keyed hostname, and it alone picks and
 *    verifies the exit node (`start.sh`); the worker only joins its network namespace;
 * 4. the tunnel must be healthy within `healthTimeoutMs`, else the sidecar is removed and `HomeRouteUnavailable` thrown
 *    (no worker has started);
 * 5. `launchWorker` runs the worker in the sidecar's namespace. If it fails the sidecar is removed too.
 *
 * `node` is the member's node as `checkHomeRoute` has just stored it.
 */
export async function launchViaHome(cfg: JobConfig, node: HomeNode, d: SidecarDeps): Promise<void> {
  const occurrenceId = cfg.occurrenceId
  const name = sidecarName(occurrenceId)
  const keyFile = authKeyPath(d.env.profileRoot, occurrenceId)
  const timeoutMs = d.healthTimeoutMs ?? 60_000
  const pollMs = d.pollMs ?? 1000

  const existing = await d.docker.inspect(name)
  if (!(existing?.running && existing.health === 'healthy')) {
    if (existing !== null) await removeSidecar(d.docker, occurrenceId)
    const body = sidecarCreateBody({
      occurrenceId,
      identityId: cfg.identity.id,
      node,
      tailscaleVersion: d.tailscaleVersion,
      env: d.env
    })
    try {
      const key = await d.api.createAuthKey({
        tags: [WORKER_TAG],
        ephemeral: true,
        expirySeconds: KEY_SECONDS,
        description: `tm-worker ${occurrenceId}`
      })
      await writeKeyFile(keyFile, key)
      const id = await d.docker.create(name, body)
      await d.docker.start(id)
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const state = await d.docker.inspect(name)
        if (state === null || !state.running) throw new HomeRouteUnavailable('The home route sidecar stopped.')
        if (state.health === 'healthy') break
        if (Date.now() >= deadline) throw new HomeRouteUnavailable('The home route tunnel did not come up in time.')
        await sleep(pollMs)
      }
    } catch (e) {
      await removeSidecar(d.docker, occurrenceId).catch(() =>
        console.error(`home-route: ${occurrenceId}: sidecar not removed`)
      )
      throw e
    } finally {
      await rm(keyFile, { force: true })
    }
  }

  let launched = false
  try {
    launched = await d.launchWorker(cfg, { sidecar: name })
  } finally {
    if (!launched) await removeSidecar(d.docker, occurrenceId)
  }
}
