import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { proxy } from '../proxy'
import { isSigninPage } from '../lib/signin-csp'

const JOB = '3f2b8a9e-6c1d-4e7a-9b0f-2d5c8e1a4f60'
const webRoot = join(import.meta.dir, '..')

// `next/experimental/testing/server` loads Next's build code, which needs `sharp` and breaks other test files that run
// in the same `bun test` process (their modules fail to load). So Next's own matcher check runs in a child process.
const PROBE = join(webRoot, 'test', 'support', 'matcher-probe.ts')

/** `[path, whether the proxy runs on it]` for each path: Next's own answer for the matcher in `proxy.ts`. */
function runsOn(paths: string[]): [string, boolean][] {
  const urls = paths.map((path) => `https://tm.example${path}`)
  const child = Bun.spawnSync([process.execPath, PROBE], {
    cwd: webRoot,
    env: { ...process.env, PROBE_URLS: JSON.stringify(urls) },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (child.exitCode !== 0) throw new Error(`the matcher probe failed: ${child.stderr.toString().slice(0, 500)}`)
  const answers: boolean[] = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!)
  return paths.map((path, i) => [path, answers[i]!])
}
const all = (paths: string[], runs: boolean) => paths.map((path): [string, boolean] => [path, runs])

describe('the proxy matcher', () => {
  test('the proxy still runs on member routes, the remote-view check and the other device routes', () => {
    const paths = [
      '/',
      '/devices',
      `/accounts/${JOB}/signin`,
      '/api/meetings/abc',
      '/api/vnc/authorize',
      '/api/companion/jobs',
      '/api/companion/pair',
      '/api/companion/events',
      `/api/companion/jobs/${JOB}/claim`,
      `/api/companion/jobs/${JOB}/audio`,
      `/api/companion/jobs/${JOB}/progress`,
      `/api/companion/jobs/${JOB}/heartbeat`,
      `/api/companion/jobs/${JOB}/complete`
    ]
    expect(runsOn(paths)).toEqual(all(paths, true))
  })

  test('the proxy does not run on the upload routes, so their bodies are never buffered', () => {
    const paths = [
      `/api/companion/jobs/${JOB}/transcript`,
      ...[
        'chat.jsonl',
        'recording/meeting.mkv',
        'recording/attempt_2_seg_014.mkv',
        'forms/f1/record.json',
        'transcript/native/audio.srt'
      ].map((file) => `/api/companion/jobs/${JOB}/files/${file}`),
      `/api/companion/jobs/${JOB.toUpperCase()}/files/chat.jsonl`
    ]
    expect(runsOn(paths)).toEqual(all(paths, false))
  })

  test('look-alikes of the upload routes stay behind the proxy', () => {
    const paths = [
      `/api/companion/jobs/${JOB}/transcript/extra`,
      `/api/companion/jobs/${JOB}/transcripts`,
      `/api/companion/jobs/%2e%2e/identities/transcript`,
      `/api/companion/jobs/${JOB}/../../identities`,
      `/api/companion/jobs/not-a-job/transcript`,
      `/api/meetings/${JOB}/transcript`,
      `/api/companionx/jobs/${JOB}/transcript`,
      `/api/companion/jobs/${JOB}/files`,
      `/api/companion/jobs/${JOB}/files/`,
      `/api/companion/jobs/${JOB}/filesx/chat.jsonl`,
      `/api/companion/jobs/not-a-job/files/chat.jsonl`,
      `/api/companion/jobs/%2e%2e/identities/files/chat.jsonl`,
      `/api/meetings/${JOB}/files/chat.jsonl`,
      // 36 characters of hex and dashes, but not the shape of a UUID.
      `/api/companion/jobs/${'-'.repeat(36)}/files/chat.jsonl`,
      `/api/companion/jobs/${'a'.repeat(36)}/transcript`,
      `/api/companion/jobs/${JOB.replaceAll('-', 'a').padEnd(36, 'a')}/files/chat.jsonl`
    ]
    expect(runsOn(paths)).toEqual(all(paths, true))
  })

  test('a device token on a member route still gets 403', async () => {
    const TOKEN = 'tmd_' + 'A'.repeat(43)
    const res = proxy(
      new NextRequest('https://tm.example/api/meetings/abc', { headers: { authorization: `Bearer ${TOKEN}` } })
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'device_token_not_allowed' })
  })

  test('isSigninPage matches /accounts/<uuid>/signin without catching other routes', () => {
    expect(isSigninPage(`/accounts/${JOB}/signin`)).toBe(true)
    expect(isSigninPage(`/accounts/${JOB.toUpperCase()}/signin`)).toBe(true)
    for (const bad of [
      '/accounts/signin',
      `/accounts/${JOB}`,
      `/accounts/${JOB}/signin/extra`,
      '/accounts/not-a-uuid/signin',
      '/accounts',
      '/'
    ]) {
      expect(isSigninPage(bad)).toBe(false)
    }
  })

  test('proxy sets per-request nonce CSP without unsafe-inline on remote sign-in page', () => {
    const res = proxy(new NextRequest(`https://tm.example/accounts/${JOB}/signin`))
    const csp = res.headers.get('content-security-policy')
    expect(csp).toBeDefined()
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("default-src 'none'")
  })
})
