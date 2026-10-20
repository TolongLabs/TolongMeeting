import { describe, expect, test } from 'bun:test'
import { MIN_DOCKER_MEM_BYTES } from '@tm/core'
import type { DesktopNotification } from '../src/notifier'
import type { DockerLike } from '../src/local/docker'
import { checkBeforeFirstRun, preflight } from '../src/local/preflight'

const REF = 'ghcr.io/tl/tolongmeeting-worker:1.0.0'

/** A `DockerLike` that answers from its options and records the image calls. */
function fakeDocker(o: { info?: null; memTotal?: number; image?: boolean; pullOk?: boolean }) {
  const calls: string[] = []
  const docker = {
    info: async () => (o.info === null ? null : { memTotal: o.memTotal ?? 8 * 1024 ** 3 }),
    imagePresent: async (ref: string) => (calls.push(`present ${ref}`), o.image ?? true),
    pull: async (ref: string) => (calls.push(`pull ${ref}`), o.pullOk ?? true)
  } as unknown as DockerLike
  return { docker, calls }
}

describe('preflight', () => {
  test('unavailable, low memory, missing image, ok', async () => {
    expect(await preflight(fakeDocker({ info: null }).docker, REF)).toEqual({
      reason: 'docker_unavailable',
      dockerMemBytes: null
    })
    expect(await preflight(fakeDocker({ memTotal: MIN_DOCKER_MEM_BYTES - 1 }).docker, REF)).toEqual({
      reason: 'docker_memory_low',
      dockerMemBytes: MIN_DOCKER_MEM_BYTES - 1
    })
    expect(
      await preflight(fakeDocker({ memTotal: MIN_DOCKER_MEM_BYTES, image: false, pullOk: false }).docker, REF)
    ).toMatchObject({ reason: 'image_unavailable' })
    expect(
      await preflight(fakeDocker({ memTotal: 8 * 1024 ** 3, image: false, pullOk: true }).docker, REF)
    ).toMatchObject({
      reason: 'ok'
    })
  })
  test('a present image is not pulled again', async () => {
    const { docker, calls } = fakeDocker({ image: true })
    expect((await preflight(docker, REF)).reason).toBe('ok')
    expect(calls).toEqual([`present ${REF}`])
  })
  test('a reference that is not registry/name@sha256 or an exact tag never reaches docker', async () => {
    for (const ref of ['--privileged', 'worker:latest', 'ghcr.io/tl/worker:1 --rm']) {
      const { docker, calls } = fakeDocker({})
      expect((await preflight(docker, ref)).reason).toBe('image_unavailable')
      expect(calls).toEqual([])
    }
  })
  test('an image outside the trusted repository is unavailable', async () => {
    const { docker, calls } = fakeDocker({ image: false })
    expect((await preflight(docker, 'ghcr.io/evil/worker:1', { imagePrefix: 'ghcr.io/tl/' })).reason).toBe(
      'image_unavailable'
    )
    expect(calls).toEqual([])
    expect((await preflight(docker, REF, { imagePrefix: 'ghcr.io/tl/' })).reason).toBe('ok')
  })
})

describe('checkBeforeFirstRun', () => {
  async function shownFor(o: Parameters<typeof fakeDocker>[0]) {
    const shown: DesktopNotification[] = []
    const report = await checkBeforeFirstRun({
      docker: fakeDocker(o).docker,
      imageRef: REF,
      notifier: { show: (n) => void shown.push(n) }
    })
    return { shown, report }
  }

  test('explains low memory in a notification', async () => {
    const { shown } = await shownFor({ memTotal: 2 * 1024 ** 3 })
    expect(shown).toEqual([
      expect.objectContaining({
        title: 'Docker Desktop needs more memory',
        body: 'Docker Desktop has 2.0 GB; local meetings need about 4 GB. Set memory=4GB or more under [wsl2] in %UserProfile%\\.wslconfig, then restart Docker Desktop.'
      })
    ])
  })
  test('tells the member to start Docker Desktop', async () => {
    const { shown, report } = await shownFor({ info: null })
    expect(report.reason).toBe('docker_unavailable')
    expect(shown).toEqual([
      expect.objectContaining({
        title: 'Start Docker Desktop',
        body: 'TolongMeeting runs meetings on this PC through Docker Desktop. Start it, and turn on "Start Docker Desktop when you sign in".'
      })
    ])
  })
  test('tells the member to log in to the registry when the image cannot be pulled', async () => {
    const { shown } = await shownFor({ image: false, pullOk: false })
    expect(shown).toEqual([
      expect.objectContaining({
        title: "Can't get the meeting worker",
        body: 'Run docker login ghcr.io with your GitHub account, then restart TolongMeeting.'
      })
    ])
  })
  test('shows nothing when all is well, and a click only closes the notification', async () => {
    expect((await shownFor({})).shown).toEqual([])
    let handlers: { click(): void; action(i: number): void } | undefined
    await checkBeforeFirstRun({
      docker: fakeDocker({ info: null }).docker,
      imageRef: REF,
      notifier: { show: (_, on) => void (handlers = on) }
    })
    expect(() => (handlers?.click(), handlers?.action(0))).not.toThrow()
  })
})
