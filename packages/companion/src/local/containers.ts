import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseJob, type JobConfig, type LocalRunPayload, type LocalSecrets, type NtfyConfig } from '@tm/core'
import { profileVolume, type LocalPaths } from './vault'

// The argument lists for the containers a local run starts. Each list goes through `DockerLike.run`, so it is checked
// by `checkRunArgs` (docker.ts) first; the flags used here are all on that allow-list already. Words after the image are
// the image's own: the worker image's ENTRYPOINT is `entrypoint.sh`, whose modes are `--job <file>` and `--signin <file>`,
// so a worker passes `--job /run/tm/job.json`, and the network holder swaps the entrypoint for `deny-private.sh`.

export const LOCAL_NETWORK = 'tm-local'
/** noVNC inside the worker's desk (plan 01c): published by the holder on 127.0.0.1 only. */
export const NOVNC_PORT = 6080
const PIDS_LIMIT = '2048'
// The server gives a worker 5 GB (container-spec.ts). On the PC it is a ceiling inside the Docker Desktop VM, not a reservation.
const WORKER_MEMORY = '5g'
const HOLDER_PIDS_LIMIT = '64'

export interface RunMounts {
  /** Host folder bound at `/tm/data` (the occurrences' data). */
  dataDir: string
  /** Host folder bound at `/tm/profiles/<id>/checkpoints`. */
  checkpointsDir: string
  /** Host folder with `job.json` and `profile.key`, bound read-only at `/run/tm`. */
  ephemeralDir: string
  /** Host file bound read-only at `/etc/machine-id`; see `writeMachineId`. */
  machineIdFile: string
}

/** `tm-net-<scope>`: the container that owns the network namespace (and its egress rules) for one run. */
export const holderName = (scope: string): string => `tm-net-${scope}`
export const signinName = (identityId: string): string => `tm-signin-${identityId}`
/** The holder of a sign-in container (plan 08 Task 10) is named from this scope. */
export const signinScope = (identityId: string): string => `signin-${identityId}`
export const workerName = (occurrenceId: string, attempt: number): string => `tm-run-${occurrenceId}-${attempt}`

// The same two rules as run-job.sh and the server (worker `profile/keys.ts`): the worker refuses to open a profile
// unless the container's host name and machine id are the identity's (`ProfileHostMismatch`).
export const hostnameFor = (identityId: string): string => `tm-${identityId.slice(0, 20)}`
export const machineIdFor = (identityId: string): string =>
  createHash('sha256').update(identityId).digest('hex').slice(0, 32)

/**
 * `<root>\machine-ids\<identityId>`: outside every folder a container mounts, so a compromised worker can't swap it
 * for a link that the next run would bind. The caller writes it with `writeFileAtomic` (temp file, then rename).
 */
export const machineIdFile = (p: LocalPaths, identityId: string): string => join(p.root, 'machine-ids', identityId)

/**
 * The network holder. It runs `deny-private.sh` (docker/egress) as root with NET_ADMIN and nothing else, publishes
 * noVNC on loopback and takes the identity's host name (Docker refuses `--hostname` on a container that joins another's
 * network, so the worker inherits this one). `--hold` keeps the namespace alive once the rules are in and checked.
 */
export function holderArgs(o: { scope: string; identityId: string; image: string; allowTcp: string[] }): string[] {
  return [
    'run',
    '-d',
    '--name',
    holderName(o.scope),
    '--label',
    `tm.identity=${o.identityId}`,
    '--hostname',
    hostnameFor(o.identityId),
    '--network',
    LOCAL_NETWORK,
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    HOLDER_PIDS_LIMIT,
    '--sysctl',
    'net.ipv6.conf.all.disable_ipv6=1',
    '--user',
    '0',
    '-p',
    `127.0.0.1::${NOVNC_PORT}`,
    '--entrypoint',
    'deny-private.sh',
    o.image,
    ...o.allowTcp.flatMap((a) => ['--allow-tcp', a]),
    '--hold'
  ]
}

/**
 * The meeting worker. It joins the holder's network, mounts only its own profile volume, checkpoints, the data folder,
 * the read-only short-lived folder and its machine id, and gets paths in `-e`, never a secret. Same hardening as the
 * server's `buildCreateBody`: no capabilities, no-new-privileges, a process limit and a memory ceiling.
 */
export function workerArgs(o: {
  occurrenceId: string
  identityId: string
  attempt: number
  image: string
  mounts: RunMounts
  scope?: string
}): string[] {
  const id = o.identityId
  return [
    'run',
    '-d',
    '--name',
    workerName(o.occurrenceId, o.attempt),
    '--label',
    `tm.identity=${id}`,
    '--label',
    `tm.occurrence=${o.occurrenceId}`,
    '--shm-size=2g',
    '--network',
    `container:${holderName(o.scope ?? o.occurrenceId)}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    PIDS_LIMIT,
    '--memory',
    WORKER_MEMORY,
    '-v',
    `${profileVolume(id)}:/tm/profiles/${id}/vol`,
    '-v',
    `${o.mounts.checkpointsDir}:/tm/profiles/${id}/checkpoints`,
    '-v',
    `${o.mounts.dataDir}:/tm/data`,
    '-v',
    `${o.mounts.ephemeralDir}:/run/tm:ro`,
    '-v',
    `${o.mounts.machineIdFile}:/etc/machine-id:ro`,
    '-e',
    'TM_DATA_ROOT=/tm/data',
    '-e',
    'TM_PROFILE_ROOT=/tm/profiles',
    '-e',
    'TM_PROFILE_KEY_FILE=/run/tm/profile.key',
    o.image,
    '--job',
    '/run/tm/job.json'
  ]
}

/**
 * The job file for one attempt: the server's template, the secrets the server handed over for this run, the PC's own
 * ntfy settings, the relay as the control channel, and container paths. The paths are made here from the ids, not
 * taken from the template: the profile volume is mounted one level up (`vol`), so the profile is `vol/work` (restore
 * renames a staging folder onto it, which a mount point would refuse with EBUSY). Validated like any job.
 */
export function localJobConfig(
  p: LocalRunPayload,
  s: LocalSecrets,
  ntfy: NtfyConfig,
  relay: { containerUrl: string; token: string },
  attempt: number
): JobConfig {
  if (p.job.occurrenceId !== p.occurrenceId || p.job.identity.id !== p.identityId) {
    throw new Error('The local run payload names two different meetings or identities')
  }
  return parseJob({
    ...p.job,
    attempt,
    ai: { ...p.job.ai, apiKey: s.apiKey },
    ntfy,
    member: { ...p.job.member, details: s.details },
    control: { url: relay.containerUrl, token: relay.token },
    dataDir: `/tm/data/occurrences/${p.occurrenceId}`,
    profileDir: `/tm/profiles/${p.identityId}/vol/work`
  })
}
