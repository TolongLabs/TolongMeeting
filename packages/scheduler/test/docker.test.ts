import { expect, test } from 'bun:test'
import { DockerError, dockerClient } from '../src/index'

type Call = {
  url: string
  method: string | undefined
  body: string | undefined
  signal: AbortSignal | null | undefined
}

/** A fetch that records each call and answers with the next canned response. */
function fakeFetch(...answers: Response[]) {
  const calls: Call[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body as string | undefined,
      signal: init?.signal
    })
    return answers.shift()!
  }) as unknown as typeof fetch
  return { fn, calls }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const empty = (status: number) => new Response(null, { status })
const BODY = { Image: 'x' } as never

test('create posts the body under the name and returns the id', async () => {
  const { fn, calls } = fakeFetch(json(201, { Id: 'abc123' }))
  expect(await dockerClient('http://proxy:2375/', fn).create('tm-worker-1', BODY)).toBe('abc123')
  expect(calls[0]).toMatchObject({
    url: 'http://proxy:2375/containers/create?name=tm-worker-1',
    method: 'POST',
    body: JSON.stringify(BODY)
  })
  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
})

test('create refuses anything but 201 and a missing id', async () => {
  const bad = fakeFetch(json(409, { message: 'name in use' }), json(201, {}))
  const docker = dockerClient('http://proxy:2375', bad.fn)
  await expect(docker.create('n', BODY)).rejects.toThrow('docker create failed (409): name in use')
  await expect(docker.create('n', BODY)).rejects.toThrow('no container id')
})

test('start and stop accept 204 and 304 and refuse the rest', async () => {
  const { fn, calls } = fakeFetch(empty(204), empty(304), empty(204), empty(304), json(500, { message: 'boom' }))
  const docker = dockerClient('http://proxy:2375', fn)
  await docker.start('id/1')
  await docker.start('id/1')
  await docker.stop('id/1', 60.9)
  await docker.stop('id/1', 60)
  expect(calls.map((c) => [c.method, c.url])).toEqual([
    ['POST', 'http://proxy:2375/containers/id%2F1/start'],
    ['POST', 'http://proxy:2375/containers/id%2F1/start'],
    ['POST', 'http://proxy:2375/containers/id%2F1/stop?t=60'],
    ['POST', 'http://proxy:2375/containers/id%2F1/stop?t=60']
  ])
  await expect(docker.start('id')).rejects.toBeInstanceOf(DockerError)
})

test('remove sends a bare DELETE and treats 404 as gone', async () => {
  const { fn, calls } = fakeFetch(empty(204), json(404, { message: 'No such container' }))
  const docker = dockerClient('http://proxy:2375', fn)
  await docker.remove('id/1')
  await docker.remove('id/1')
  expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
    ['DELETE', 'http://proxy:2375/containers/id%2F1', undefined],
    ['DELETE', 'http://proxy:2375/containers/id%2F1', undefined]
  ])
  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
})

test('remove refuses a conflict, a gate refusal and a server error', async () => {
  const { fn } = fakeFetch(
    json(409, { message: 'container is running' }),
    json(403, { message: 'container is not stopped' }),
    json(500, { message: 'boom' })
  )
  const docker = dockerClient('http://proxy:2375', fn)
  await expect(docker.remove('c')).rejects.toThrow('docker remove failed (409): container is running')
  await expect(docker.remove('c')).rejects.toThrow('docker remove failed (403): container is not stopped')
  await expect(docker.remove('c')).rejects.toBeInstanceOf(DockerError)
})

test('inspect answers running, stopped or null for a 404', async () => {
  const { fn, calls } = fakeFetch(
    json(200, { State: { Running: true } }),
    json(200, { State: { Running: false } }),
    json(404, { message: 'No such container' }),
    json(502, {})
  )
  const docker = dockerClient('http://proxy:2375', fn)
  expect(await docker.inspect('c')).toEqual({ running: true })
  expect(await docker.inspect('c')).toEqual({ running: false })
  expect(await docker.inspect('c')).toBeNull()
  await expect(docker.inspect('c')).rejects.toThrow('docker inspect failed (502)')
  expect(calls[0]).toMatchObject({ url: 'http://proxy:2375/containers/c/json' })
  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
})

// A fetch that never answers on its own but, like the real one, rejects when its signal aborts.
const hang = ((_url: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
  })) as unknown as typeof fetch

test('a call that never answers becomes a DockerError once its time is up', async () => {
  const docker = dockerClient('http://proxy:2375', hang, { quickMs: 20, slowMs: 30 })
  for (const call of [
    () => docker.inspect('c'),
    () => docker.stop('c', 10),
    () => docker.remove('c'),
    () => docker.start('c'),
    () => docker.create('n', BODY)
  ]) {
    const e = await call().catch((err: unknown) => err)
    expect(e).toBeInstanceOf(DockerError)
    expect((e as DockerError).message).toMatch(/no answer within (20|30) ms/)
  }
})

test('the default limits are 10 s for inspect, stop and remove and 60 s for create and start', async () => {
  const seen: { path: string; signal: AbortSignal }[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    seen.push({ path: url, signal: init!.signal! })
    return url.endsWith('/json')
      ? json(200, { State: {} })
      : url.includes('create')
        ? json(201, { Id: 'x' })
        : empty(204)
  }) as unknown as typeof fetch
  const timeouts: number[] = []
  const original = AbortSignal.timeout
  AbortSignal.timeout = (ms: number) => (timeouts.push(ms), original.call(AbortSignal, ms))
  try {
    const docker = dockerClient('http://proxy:2375', fn)
    await docker.inspect('c')
    await docker.stop('c', 1)
    await docker.remove('c')
    await docker.create('n', BODY)
    await docker.start('c')
  } finally {
    AbortSignal.timeout = original
  }
  expect(timeouts).toEqual([10_000, 10_000, 10_000, 60_000, 60_000])
})

test('an unreachable proxy is a DockerError that does not carry the URL', async () => {
  const down = (async () => {
    throw new Error('connect ECONNREFUSED http://proxy:2375/secret')
  }) as unknown as typeof fetch
  const e = await dockerClient('http://proxy:2375', down)
    .inspect('c')
    .catch((err: unknown) => err)
  expect(e).toBeInstanceOf(DockerError)
  expect((e as DockerError).message).toBe('docker inspect failed (0): proxy unreachable')
})
