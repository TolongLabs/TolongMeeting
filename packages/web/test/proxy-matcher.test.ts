import { describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { config, proxy } from '../proxy'

const JOB = '3f2b8a9e-6c1d-4e7a-9b0f-2d5c8e1a4f60'
const runsOn = (url: string) => unstable_doesMiddlewareMatch({ config, url })

describe('the proxy matcher', () => {
  test('the proxy still runs on member routes, the remote-view check and the other device routes', () => {
    for (const path of [
      '/',
      '/devices',
      '/api/meetings/abc',
      '/api/vnc/authorize',
      '/api/companion/jobs',
      '/api/companion/pair',
      '/api/companion/events',
      `/api/companion/jobs/${JOB}/claim`,
      `/api/companion/jobs/${JOB}/audio`,
      `/api/companion/jobs/${JOB}/progress`
    ]) {
      expect([path, runsOn(`https://tm.example${path}`)]).toEqual([path, true])
    }
  })

  test('the proxy does not run on the transcript upload route, so its body is never buffered', () => {
    expect(runsOn(`https://tm.example/api/companion/jobs/${JOB}/transcript`)).toBe(false)
  })

  test('the proxy does not run on the local-run chunk upload route, whatever the file path', () => {
    for (const path of [
      'chat.jsonl',
      'recording/meeting.mkv',
      'recording/attempt_2_seg_014.mkv',
      'forms/f1/record.json',
      'transcript/native/audio.srt'
    ]) {
      expect([path, runsOn(`https://tm.example/api/companion/jobs/${JOB}/files/${path}`)]).toEqual([path, false])
    }
  })

  test('look-alikes of the upload routes stay behind the proxy', () => {
    for (const path of [
      `/api/companion/jobs/${JOB}/files`,
      `/api/companion/jobs/${JOB}/files/`,
      `/api/companion/jobs/${JOB}/filesx/chat.jsonl`,
      `/api/companion/jobs/not-a-job/files/chat.jsonl`,
      `/api/companion/jobs/%2e%2e/identities/files/chat.jsonl`,
      `/api/meetings/${JOB}/files/chat.jsonl`
    ]) {
      expect([path, runsOn(`https://tm.example${path}`)]).toEqual([path, true])
    }
  })

  test('look-alikes of the transcript upload route stay behind the proxy', () => {
    for (const path of [
      `/api/companion/jobs/${JOB}/transcript/extra`,
      `/api/companion/jobs/${JOB}/transcripts`,
      `/api/companion/jobs/%2e%2e/identities/transcript`,
      `/api/companion/jobs/${JOB}/../../identities`,
      `/api/companion/jobs/not-a-job/transcript`,
      `/api/meetings/${JOB}/transcript`,
      `/api/companionx/jobs/${JOB}/transcript`
    ]) {
      expect([path, runsOn(`https://tm.example${path}`)]).toEqual([path, true])
    }
  })

  test('a device token on a member route still gets 403', async () => {
    const TOKEN = 'tmd_' + 'A'.repeat(43)
    const res = proxy(
      new NextRequest('https://tm.example/api/meetings/abc', { headers: { authorization: `Bearer ${TOKEN}` } })
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'device_token_not_allowed' })
  })
})
