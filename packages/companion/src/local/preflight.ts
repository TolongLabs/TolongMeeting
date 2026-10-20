import { MIN_DOCKER_MEM_BYTES, type PreflightReport } from '@tm/core'
import type { DesktopNotification, DesktopNotifier } from '../notifier'
import { imageRefOk, type DockerLike } from './docker'

/**
 * Asks, in order: is Docker running, does it have enough memory, is the worker image here (or can it be pulled).
 * An image reference that fails the strict check is never handed to Docker and counts as unavailable.
 */
export async function preflight(
  docker: DockerLike,
  imageRef: string,
  opts: { imagePrefix?: string } = {}
): Promise<PreflightReport> {
  const info = await docker.info()
  if (info === null) return { reason: 'docker_unavailable', dockerMemBytes: null }
  if (info.memTotal < MIN_DOCKER_MEM_BYTES) return { reason: 'docker_memory_low', dockerMemBytes: info.memTotal }
  const image: PreflightReport = { reason: 'image_unavailable', dockerMemBytes: info.memTotal }
  if (!imageRefOk(imageRef, opts.imagePrefix)) return image
  if ((await docker.imagePresent(imageRef)) || (await docker.pull(imageRef))) {
    return { reason: 'ok', dockerMemBytes: info.memTotal }
  }
  return image
}

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

function explain(report: PreflightReport): DesktopNotification | null {
  const base = { sticky: false, buttons: [] }
  switch (report.reason) {
    case 'ok':
      return null
    case 'docker_memory_low':
      return {
        ...base,
        title: 'Docker Desktop needs more memory',
        body: `Docker Desktop has ${gb(report.dockerMemBytes ?? 0)} GB; local meetings need about 4 GB. Set memory=4GB or more under [wsl2] in %UserProfile%\\.wslconfig, then restart Docker Desktop.`
      }
    case 'docker_unavailable':
      return {
        ...base,
        title: 'Start Docker Desktop',
        body: 'TolongMeeting runs meetings on this PC through Docker Desktop. Start it, and turn on "Start Docker Desktop when you sign in".'
      }
    case 'image_unavailable':
      return {
        ...base,
        title: "Can't get the meeting worker",
        body: 'Run docker login ghcr.io with your GitHub account, then restart TolongMeeting.'
      }
  }
}

/** Runs the preflight and, for a problem the member can fix, shows one notification. A click only closes it. */
export async function checkBeforeFirstRun(d: {
  docker: DockerLike
  imageRef: string
  notifier: DesktopNotifier
  imagePrefix?: string
}): Promise<PreflightReport> {
  const report = await preflight(
    d.docker,
    d.imageRef,
    d.imagePrefix === undefined ? {} : { imagePrefix: d.imagePrefix }
  )
  const note = explain(report)
  if (note !== null) d.notifier.show(note, { click: () => {}, action: () => {} })
  return report
}
