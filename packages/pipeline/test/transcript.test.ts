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
  // The gap runs from 131 s to 200 s, after the last line, so the 124 s pause before 'Okay.' is all silence.
  const b = paragraphs(speechLines, [{ atMs: 200_000, ms: 69_000 }])
  expect(b).toEqual([
    { kind: 'para', atMs: 0, text: 'Selamat petang. Today, clustering.' },
    { kind: 'para', atMs: 5200, text: 'First,' },
    { kind: 'silence', atMs: 6000, ms: 124_000 },
    { kind: 'para', atMs: 130_000, text: 'Okay.' },
    { kind: 'gap', atMs: 200_000, ms: 69_000 }
  ])
})

test('a recording gap inside a long pause is not also silence', () => {
  const b = paragraphs(
    [liveLine(0, 1000, 'Selamat petang.'), liveLine(200_000, 201_000, 'Okay.')],
    [{ atMs: 150_000, ms: 100_000 }]
  )
  // 199 s of pause, 100 s of it recorded as a gap, leaves 99 s of silence: under the 2 minute note.
  expect(b).toEqual([
    { kind: 'para', atMs: 0, text: 'Selamat petang.' },
    { kind: 'gap', atMs: 150_000, ms: 100_000 },
    { kind: 'para', atMs: 200_000, text: 'Okay.' }
  ])
})

test('a gap of unknown length inside a pause suppresses the silence note', () => {
  const b = paragraphs(
    [liveLine(0, 1000, 'Selamat petang.'), liveLine(300_000, 301_000, 'Okay.')],
    [{ atMs: 200_000, ms: null }]
  )
  expect(b).toEqual([
    { kind: 'para', atMs: 0, text: 'Selamat petang.' },
    { kind: 'gap', atMs: 200_000, ms: null },
    { kind: 'para', atMs: 300_000, text: 'Okay.' }
  ])
})

test('live rows are read in start order, so an out-of-order row does not hide a pause', () => {
  const b = paragraphs([liveLine(130_000, 131_000, 'Okay.'), liveLine(0, 1000, 'Selamat petang.')], [])
  expect(b).toEqual([
    { kind: 'para', atMs: 0, text: 'Selamat petang.' },
    { kind: 'silence', atMs: 1000, ms: 129_000 },
    { kind: 'para', atMs: 130_000, text: 'Okay.' }
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
  // The first attempt stops at 131 s, just after 'Okay.', so the gap is 69 s long.
  await writeAttempts(occ.dataDir, [
    { startMs: 0, stopMs: 131_000 },
    { startMs: 200_000, stopMs: null }
  ])

  const path = await buildTranscript(occ.cfg, [])
  expect(path).toBe(join(occ.dataDir, 'out', 'transcript.md'))
  const md = await Bun.file(path).text()
  expect(md).toStartWith(
    '# Data Mining: transcript\n\nWed 21 Oct 2026, 20:00 to 22:00 (Asia/Kuala_Lumpur). Live transcription; times are from the recording start, and names may be misheard.\n\n## Transcript\n\n**[00:00:00]** Selamat petang. Today, clustering.'
  )
  expect(md).toBe(
    '# Data Mining: transcript\n\n' +
      'Wed 21 Oct 2026, 20:00 to 22:00 (Asia/Kuala_Lumpur). Live transcription; times are from the recording start, and names may be misheard.\n\n' +
      '## Transcript\n\n' +
      '**[00:00:00]** Selamat petang. Today, clustering.\n\n' +
      '**[00:00:05]** First,\n\n' +
      '_[00:00:06] No speech for 2 minutes._\n\n' +
      '**[00:02:10]** Okay.\n\n' +
      '_[00:03:20] Recording gap of 1 minute._\n'
  )
})

test('a crashed attempt without stoppedAt gives a gap of unknown length, not an error', async () => {
  const occ = await occurrence()
  await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), [liveLine(0, 1000, 'Selamat petang.')])
  await writeAttempts(occ.dataDir, [
    { startMs: 0, stopMs: null },
    { startMs: 200_000, stopMs: 260_000 }
  ])

  const md = await Bun.file(await buildTranscript(occ.cfg, [])).text()
  expect(
    md.endsWith('## Transcript\n\n**[00:00:00]** Selamat petang.\n\n_[00:03:20] Recording gap (length unknown)._\n')
  ).toBe(true)
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
