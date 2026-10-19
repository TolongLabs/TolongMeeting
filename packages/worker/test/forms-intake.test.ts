import { expect, spyOn, test } from 'bun:test'
import type { FormCandidate, ResolvedForm } from '@tm/core'
import type { Ping } from '@tm/notify'
import type { FormDispatcher } from '../src/forms/dispatcher'
import { onFormCandidate, type IntakeDeps } from '../src/forms/intake'
import { LinkResolveError } from '../src/forms/links'
import { testJob } from './forms/job'

const cfg = testJob('/unused')
const cand: FormCandidate = {
  url: 'https://docs.google.com/forms/d/e/x/viewform',
  source: 'meeting_chat',
  sender: 'Dr Example',
  senderRole: 'host',
  seenAt: '2026-10-20T12:41:00.000Z'
}
const resolved: ResolvedForm = { ...cand, finalUrl: cand.url, provider: 'google' }

// Everything the intake talks to, recorded. `deps` can be patched per test.
function harness(patch: Partial<IntakeDeps> = {}) {
  const offered: ResolvedForm[] = []
  const events: [string, Record<string, unknown>][] = []
  const pings: Ping[] = []
  const dispatcher: FormDispatcher = { offer: (f) => void offered.push(f), close: async () => [] }
  const deps: IntakeDeps = {
    cfg,
    resolve: async () => resolved,
    dispatcher,
    emitEvent: async (type, data) => void events.push([type, data]),
    ping: async (p) => void pings.push(p),
    inFlight: new Set(),
    pinged: new Set(),
    ...patch
  }
  return { deps, offered, events, pings }
}

test('a resolved candidate is offered to the dispatcher', async () => {
  const h = harness()
  await onFormCandidate(cand, h.deps)
  expect(h.offered).toEqual([resolved])
  expect(h.events).toEqual([])
  expect(h.pings).toEqual([])
})

test('a link that is not a form is logged by host only and not offered', async () => {
  const h = harness({ resolve: async () => null })
  await onFormCandidate({ ...cand, url: 'https://example.zoom.us/j/1?pwd=PASSCODE' }, h.deps)
  expect(h.offered).toEqual([])
  expect(h.pings).toEqual([])
  expect(h.events).toEqual([
    [
      'form',
      { formId: null, outcome: 'ignored', reason: 'not_a_form', host: 'example.zoom.us', source: 'meeting_chat' }
    ]
  ])
  expect(JSON.stringify(h.events)).not.toContain('PASSCODE')
})

test('text that is not a URL is ignored without calling the resolver', async () => {
  const h = harness({
    resolve: async () => {
      throw new Error('must not resolve')
    }
  })
  await onFormCandidate({ ...cand, url: 'WIFI:S:lab;P:secret;;' }, h.deps)
  expect(h.events).toEqual([
    ['form', { formId: null, outcome: 'ignored', reason: 'not_a_url', host: null, source: 'meeting_chat' }]
  ])
})

test('a link that cannot be resolved is logged by host, and a trusted sender hears about it', async () => {
  const link = 'https://forms.gle/abc?pwd=PASSCODE'
  const h = harness({
    resolve: async () => {
      throw new LinkResolveError('timeout', 'form link forms.gle/abc timed out')
    }
  })
  await onFormCandidate({ ...cand, url: link }, h.deps)
  expect(h.offered).toEqual([])
  expect(h.events).toEqual([
    ['form', { formId: null, outcome: 'unresolved', reason: 'timeout', host: 'forms.gle', source: 'meeting_chat' }]
  ])
  expect(JSON.stringify(h.events)).not.toContain('PASSCODE')
  expect(h.pings).toEqual([
    {
      title: 'Link seen, not checked: Example lecture',
      message: "Dr Example shared a link at 20:41 that couldn't be checked within 5 seconds. It may be a form.",
      priority: 'high',
      actions: [{ label: 'Open link', url: link }]
    }
  ])
})

test('an unresolved link from an untrusted sender is logged but not pinged', async () => {
  const h = harness({
    resolve: async () => {
      throw new LinkResolveError('network', 'form link forms.gle/abc could not be reached')
    }
  })
  await onFormCandidate({ ...cand, sender: 'Classmate', senderRole: 'participant' }, h.deps)
  expect(h.pings).toEqual([])
  expect(h.events.map(([, d]) => [d.outcome, d.reason])).toEqual([['unresolved', 'network']])
})

test('the same raw link is resolved once while it is in flight, and again once it is done', async () => {
  let resolves = 0
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const h = harness({
    resolve: async () => {
      resolves += 1
      await gate
      return resolved
    }
  })
  const first = onFormCandidate(cand, h.deps)
  await onFormCandidate(cand, h.deps) // returns at once: the link is in flight
  expect(resolves).toBe(1)
  release()
  await first
  expect(h.offered).toEqual([resolved])
  await onFormCandidate(cand, h.deps) // a later sighting (say a trusted sender's) must reach the dispatcher
  expect(h.offered).toEqual([resolved, resolved])
})

test('with no dispatcher every resolved form reaches the member, trusted or not, by its canonical URL', async () => {
  const trusted = harness({ dispatcher: null })
  await onFormCandidate(cand, trusted.deps)
  expect(trusted.events.map(([, d]) => [d.outcome, d.reason])).toEqual([['unresolved', 'dispatcher_unavailable']])
  expect(trusted.pings.map((p) => [p.title, p.message])).toEqual([
    [
      'Form seen, not filled: Example lecture',
      'Dr Example shared a form at 20:41. The bot did not fill it. Open it yourself.'
    ]
  ])

  const untrusted = harness({ dispatcher: null })
  await onFormCandidate({ ...cand, sender: 'Classmate', senderRole: 'participant' }, untrusted.deps)
  expect(untrusted.events).toHaveLength(1)
  expect(untrusted.pings.map((p) => [p.title, p.message.startsWith('Classmate shared a form')])).toEqual([
    ['Form seen, not filled: Example lecture', true]
  ])
})

test('the ping of a form nobody can handle never carries the pre-filled answers of the raw link', async () => {
  const raw = 'https://docs.google.com/forms/d/e/x/formResponse?entry.1=x&submit=Submit'
  const h = harness({ dispatcher: null, resolve: async (c) => ({ ...c, finalUrl: c.url, provider: 'google' }) })
  await onFormCandidate({ ...cand, url: raw }, h.deps)
  expect(h.pings).toHaveLength(1)
  const [action] = h.pings[0]!.actions!
  expect(action!.url).toBe('https://docs.google.com/forms/d/e/x/viewform')
  for (const leak of ['entry.', 'submit', 'formResponse']) {
    expect(action!.url).not.toContain(leak)
    expect(JSON.stringify(h.pings)).not.toContain(leak)
  }
})

test('a link is pinged as unchecked once, even when it is seen again (a chat replay)', async () => {
  const h = harness({
    resolve: async () => {
      throw new LinkResolveError('timeout', 'timed out')
    }
  })
  await onFormCandidate(cand, h.deps)
  await onFormCandidate(cand, h.deps)
  expect(h.pings).toHaveLength(1)
  expect(h.events).toHaveLength(2)
})

test('the member is pinged before the event is written, and a failed ping is tried again at the next sighting', async () => {
  const order: string[] = []
  let fail = true
  const h = harness({
    resolve: async () => {
      throw new LinkResolveError('timeout', 'timed out')
    },
    ping: async () => {
      order.push('ping')
      if (fail) throw new Error('ntfy down')
    },
    emitEvent: async (type) => void order.push(type)
  })
  await onFormCandidate(cand, h.deps)
  expect(order).toEqual(['ping', 'form', 'error'])
  fail = false
  await onFormCandidate(cand, h.deps)
  expect(order.filter((o) => o === 'ping')).toHaveLength(2)
})

test('a trusted repost of a link that is resolving for an untrusted sender is not dropped', async () => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const h = harness({
    resolve: async () => {
      await gate
      return resolved
    }
  })
  const peer = { ...cand, sender: 'Classmate', senderRole: 'participant' as const }
  const first = onFormCandidate(peer, h.deps)
  const second = onFormCandidate(cand, h.deps)
  release()
  await Promise.all([first, second])
  expect(h.offered).toHaveLength(2)
})

test('a failure never rejects: it becomes an error event with the member details masked', async () => {
  const h = harness({
    resolve: async () => {
      throw new Error('boom for A00000000')
    }
  })
  await onFormCandidate(cand, h.deps)
  expect(h.events).toEqual([['error', { where: 'form_intake', host: 'docs.google.com', message: 'boom for [value]' }]])
  expect(h.deps.inFlight.size).toBe(0)
})

test('a failing ping and a failing event writer never reject either', async () => {
  const link = { ...cand, url: 'https://forms.gle/abc' }
  const unresolved = () => {
    throw new LinkResolveError('timeout', 'timed out')
  }
  const pingFails = harness({
    resolve: async () => unresolved(),
    ping: async () => {
      throw new Error('ntfy down')
    }
  })
  await onFormCandidate(link, pingFails.deps)
  expect(pingFails.events.map(([type, d]) => [type, d.where ?? d.outcome])).toEqual([
    ['form', 'unresolved'],
    ['error', 'form_intake']
  ])

  const stderr = spyOn(console, 'error').mockImplementation(() => {})
  const writerFails = harness({
    resolve: async () => unresolved(),
    emitEvent: async () => {
      throw new Error('disk full')
    }
  })
  await onFormCandidate(link, writerFails.deps)
  expect(writerFails.deps.inFlight.size).toBe(0)
  expect(stderr).toHaveBeenCalledWith('[tm-worker] could not emit a error event')
  stderr.mockRestore()
})
