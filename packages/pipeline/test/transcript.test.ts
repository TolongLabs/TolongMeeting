import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { buildTranscript, isHallucination, paragraphs } from '../src/transcript'
import { liveLine, makeOccurrence, removeOccurrence, writeAttempts, writeLines } from './helpers'

const occurrences: string[] = []
afterEach(async () => {
  for (const root of occurrences.splice(0)) await removeOccurrence(root)
})

async function occurrence() {
  const occ = await makeOccurrence()
  occurrences.push(occ.root)
  return occ
}

const speechLines = [
  liveLine(0, 1000, 'Selamat petang.'),
  liveLine(1500, 3000, 'Today, clustering.'),
  liveLine(5200, 6000, 'First,'),
  liveLine(130_000, 131_000, 'Okay.')
]

test('hallucinations are dropped', () => {
  for (const t of ['you', 'You.', 'Thank you for watching!', 'thanks for watching', '.'])
    expect(isHallucination(t)).toBe(true)
  expect(isHallucination('Thank you, everyone')).toBe(false)
})

test('paragraphs on pauses of 2 s or 600 characters, silence notes from 2 minutes, recording gaps', () => {
  const b = paragraphs(speechLines.slice(0, 3).concat(speechLines[3]), [{ atMs: 200_000, ms: 120_000 }])
  expect(b).toEqual([
    { kind: 'para', atMs: 0, text: 'Selamat petang. Today, clustering.' },
    { kind: 'para', atMs: 5200, text: 'First,' },
    { kind: 'silence', atMs: 6000, ms: 124_000 },
    { kind: 'para', atMs: 130_000, text: 'Okay.' },
    { kind: 'gap', atMs: 200_000, ms: 120_000 }
  ])
})

test('a new paragraph starts once the current one reaches 600 characters', async () => {
  const occ = await occurrence()
  const long = 'x'.repeat(100)
  const lines = Array.from({ length: 7 }, (_, i) => liveLine(i * 200, i * 200 + 100, long))
  await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), lines)
  await writeAttempts(occ.dataDir, [{ startMs: 0, stopMs: null }])

  const md = await Bun.file(await buildTranscript(occ.cfg, [])).text()
  const first = Array(6).fill(long).join(' ')
  expect(md.endsWith(`## Transcript\n\n**[00:00:00]** ${first}\n\n**[00:00:01]** ${long}\n`)).toBe(true)
})

test('transcript.md format', async () => {
  const occ = await occurrence()
  await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), speechLines)
  await writeAttempts(occ.dataDir, [
    { startMs: 0, stopMs: 80_000 },
    { startMs: 200_000, stopMs: null }
  ])

  const path = await buildTranscript(occ.cfg, [])
  expect(path).toBe(join(occ.dataDir, 'out', 'transcript.md'))
  const md = await Bun.file(path).text()
  expect(md).toStartWith(
    '# Data Mining: transcript\n\nWed 21 Oct 2026, 20:00 to 22:00 (Asia/Kuala_Lumpur). Live transcription; times are from the recording start, and names may be misheard.\n\n## Transcript\n\n**[00:00:00]** Selamat petang. Today, clustering.'
  )
  expect(md).toContain('_[00:00:06] No speech for 2 minutes._')
  expect(md).toContain('_[00:03:20] Recording gap of 2 minutes._')
  expect(md).toBe(
    '# Data Mining: transcript\n\n' +
      'Wed 21 Oct 2026, 20:00 to 22:00 (Asia/Kuala_Lumpur). Live transcription; times are from the recording start, and names may be misheard.\n\n' +
      '## Transcript\n\n' +
      '**[00:00:00]** Selamat petang. Today, clustering.\n\n' +
      '**[00:00:05]** First,\n\n' +
      '_[00:00:06] No speech for 2 minutes._\n\n' +
      '**[00:02:10]** Okay.\n\n' +
      '_[00:03:20] Recording gap of 2 minutes._\n'
  )
})

test('hallucinated lines never reach the transcript', async () => {
  const occ = await occurrence()
  await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), [
    liveLine(0, 500, 'you'),
    liveLine(1000, 2000, 'Selamat petang.'),
    liveLine(2500, 3000, 'Thank you for watching!'),
    liveLine(3100, 3200, '.'),
    liveLine(3300, 4000, 'Thank you, everyone')
  ])
  await writeAttempts(occ.dataDir, [{ startMs: 0, stopMs: null }])

  const md = await Bun.file(await buildTranscript(occ.cfg, [])).text()
  expect(md.endsWith('## Transcript\n\n**[00:00:01]** Selamat petang. Thank you, everyone\n')).toBe(true)
})

test('names in the transcript are corrected against the vocabulary and marked as heard', async () => {
  const occ = await occurrence()
  await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), [
    liveLine(0, 3000, 'thanks Dr Amina, today Kubernetis and Kubernetes')
  ])
  await writeAttempts(occ.dataDir, [{ startMs: 0, stopMs: null }])

  const md = await Bun.file(await buildTranscript(occ.cfg, ['Dr Aminah', 'Kubernetes'])).text()
  expect(
    md.endsWith(
      '## Transcript\n\n**[00:00:00]** thanks Dr Aminah _(as heard: "Dr Amina")_, today Kubernetes _(as heard: "Kubernetis")_ and Kubernetes\n'
    )
  ).toBe(true)
})

test('a missing live transcript says so', async () => {
  const occ = await occurrence()
  const md = await Bun.file(await buildTranscript(occ.cfg, [])).text()
  expect(md.endsWith('## Transcript\n\n_No live transcript for this meeting._\n')).toBe(true)
})
