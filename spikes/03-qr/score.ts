// Score QR decode results against the deck plan (plan 00, task 3, step 4).
// bun score.ts --decodes decodes.csv --plan deck-plan.csv --slide-starts slide-starts.csv --out summary.json
//   [--bridge bridge.json] [--main A,B] [--stress C]
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    decodes: { type: 'string' },
    plan: { type: 'string' },
    'slide-starts': { type: 'string' },
    out: { type: 'string' },
    bridge: { type: 'string' },
    main: { type: 'string', default: 'A,B' },
    stress: { type: 'string', default: 'C' }
  }
})
for (const k of ['decodes', 'plan', 'slide-starts', 'out'] as const) if (!args[k]) throw new Error(`missing --${k}`)

const SLIDE_SECONDS = 60
const FRAME_STEP = 2
const ACCEPT_WITHIN = 10
const Q3_MIN_SIZE = 12
const Q2_SIZE = 8
const P95_LIMIT_MS = 1500
const BRIDGE_LIMIT_MS = 100
const START_LIMIT_MS = 5000

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '')
}
function table(path: string): Record<string, string>[] {
  const [head, ...rest] = parseCsv(readFileSync(path, 'utf8'))
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}
const hms = (s: string) => {
  const [h, m, sec] = s.split(':').map(Number)
  return h * 3600 + m * 60 + sec
}
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}
const round = (n: number, d = 1) => (Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d)

type Code = { slide: number; kind: string; size: number; position: string; url: string }
const plan: Code[] = table(args.plan!)
  .filter((r) => r.urlKind !== 'none')
  .map((r) => ({ slide: +r.slide, kind: r.urlKind, size: +r.sizePct, position: r.position, url: r.url }))
const slideCount = Math.max(...table(args.plan!).map((r) => +r.slide))
const starts = new Map(table(args['slide-starts']!).map((r) => [+r.slide, hms(r.start)]))
const expected = new Map<number, Set<string>>()
for (let s = 1; s <= slideCount; s++) expected.set(s, new Set(plan.filter((c) => c.slide === s).map((c) => c.url)))

function slideAt(t: number): number {
  for (const [s, st] of starts) if (t >= st && t < st + SLIDE_SECONDS) return s
  throw new Error(`frame at ${t}s is outside every slide`)
}

type Stage = { texts: string[]; ms: number }
type FrameRec = { cond: string; name: string; t: number; slide: number; stages: Map<string, Stage> }
const frames = new Map<string, FrameRec>()
for (const r of table(args.decodes!)) {
  const [cond, name] = r.frame.split('/')
  const t = +r.tSec
  const f = frames.get(r.frame) ?? { cond, name, t, slide: slideAt(t), stages: new Map() }
  f.stages.set(`${r.decoder}:${r.mode}`, { texts: JSON.parse(r.texts) as string[], ms: +r.ms })
  frames.set(r.frame, f)
}

// A pipeline runs its stages in order and stops at the first stage that returns any text.
const PIPELINES: Record<string, string[]> = {
  zxing: ['zxing:full', 'zxing:region'],
  wechat: ['wechat:full', 'wechat:region'],
  both: ['zxing:full', 'zxing:region', 'wechat:full', 'wechat:region'],
  // not a candidate: runs every stage and keeps the union, so a frame with two codes yields both
  bothUnion: ['zxing:full', 'zxing:region', 'wechat:full', 'wechat:region']
}
function run(f: FrameRec, stages: string[], union: boolean): Stage {
  let ms = 0
  const texts = new Set<string>()
  for (const s of stages) {
    const st = f.stages.get(s)
    if (!st) throw new Error(`frame ${f.cond}/${f.name} has no ${s} row`)
    ms += st.ms
    for (const t of st.texts) texts.add(t)
    if (texts.size && !union) break
  }
  return { texts: [...texts], ms }
}

const bridge = args.bridge
  ? (JSON.parse(readFileSync(args.bridge, 'utf8')) as { startMs: number; overheadP95Ms: number })
  : null

function evaluateSet(conds: string[]) {
  const fs = [...frames.values()].filter((f) => conds.includes(f.cond)).sort((a, b) => a.t - b.t)
  const sizes = [...new Set(plan.map((c) => c.size))].sort((a, b) => a - b)
  const kinds = [...new Set(plan.map((c) => c.kind))]
  const out: Record<string, unknown> = {}
  for (const [pname, stages] of Object.entries(PIPELINES)) {
    const results = new Map(fs.map((f) => [f, run(f, stages, pname === 'bothUnion')]))
    // Q1
    let wrong = 0
    let blankDecodes = 0
    const wrongSamples: string[] = []
    for (const f of fs) {
      for (const text of results.get(f)!.texts) {
        if (!expected.get(f.slide)!.has(text)) {
          wrong++
          wrongSamples.push(`${f.cond}/${f.name}: ${text.slice(0, 60)}`)
          if (expected.get(f.slide)!.size === 0) blankDecodes++
        }
      }
    }
    // per code: hit flags per frame and acceptance time
    const perCode = plan.map((c) => {
      const byCond = conds.map((cond) => {
        const cf = fs.filter((f) => f.cond === cond && f.slide === c.slide)
        const hits = cf.map((f) => results.get(f)!.texts.includes(c.url))
        let accepted: number | null = null
        for (let i = 1; i < cf.length; i++)
          if (hits[i] && hits[i - 1]) {
            accepted = cf[i].t - starts.get(c.slide)!
            break
          }
        return { cond, frames: cf.length, hits: hits.filter(Boolean).length, accepted }
      })
      return { code: c, byCond }
    })
    const rateOf = (pred: (c: Code) => boolean) => {
      let h = 0
      let n = 0
      for (const pc of perCode) if (pred(pc.code)) for (const b of pc.byCond) ((h += b.hits), (n += b.frames))
      return n ? h / n : NaN
    }
    const acceptedOf = (pred: (c: Code) => boolean) => {
      let ok = 0
      let n = 0
      for (const pc of perCode)
        if (pred(pc.code))
          for (const b of pc.byCond) {
            n++
            if (b.accepted !== null && b.accepted <= ACCEPT_WITHIN) ok++
          }
      return { ok, n }
    }
    const sizeCurve = sizes.map((s) => {
      const acc = acceptedOf((c) => c.size === s)
      return {
        sizePct: s,
        frameRate: round(
          rateOf((c) => c.size === s),
          3
        ),
        accepted: `${acc.ok}/${acc.n}`,
        byKind: Object.fromEntries(
          kinds.map((k) => {
            const a = acceptedOf((c) => c.size === s && c.kind === k)
            return [
              k,
              {
                frameRate: round(
                  rateOf((c) => c.size === s && c.kind === k),
                  3
                ),
                accepted: `${a.ok}/${a.n}`
              }
            ]
          })
        )
      }
    })
    const allAcceptedFrom = (s: number) => {
      const a = acceptedOf((c) => c.size >= s)
      return a.ok === a.n
    }
    const minSize = sizes.find((s) => allAcceptedFrom(s)) ?? null
    const q2 = acceptedOf((c) => c.size >= Q2_SIZE)
    const acceptTimes = perCode
      .filter((pc) => pc.code.size >= Q3_MIN_SIZE)
      .flatMap((pc) => pc.byCond.map((b) => b.accepted))
      .filter((t): t is number => t !== null)
    const q3rate = rateOf((c) => c.size >= Q3_MIN_SIZE)
    const times = [...results.values()].map((r) => r.ms)
    const p95 = pct(times, 95)
    const q5 =
      pname === 'zxing' ? null : bridge ? { startMs: bridge.startMs, overheadP95Ms: bridge.overheadP95Ms } : undefined
    out[pname] = {
      Q1: {
        pass: wrong === 0,
        wrongDecodes: wrong,
        blankSlideDecodes: blankDecodes,
        samples: wrongSamples.slice(0, 5)
      },
      Q2: {
        pass: q2.ok === q2.n,
        accepted: `${q2.ok}/${q2.n}`,
        sizeThreshold: Q2_SIZE,
        acceptSecAtOrAbove12: { p50: pct(acceptTimes, 50), max: Math.max(...acceptTimes) }
      },
      Q3: { pass: q3rate >= 0.9, frameRate: round(q3rate, 3), sizeThreshold: Q3_MIN_SIZE },
      Q4: {
        pass: p95 <= P95_LIMIT_MS,
        p50Ms: round(pct(times, 50)),
        p95Ms: round(p95),
        maxMs: round(Math.max(...times))
      },
      Q5:
        q5 === null
          ? { pass: true, applicable: false }
          : q5 === undefined
            ? { pass: false, applicable: true, note: 'no --bridge file' }
            : { pass: q5.overheadP95Ms <= BRIDGE_LIMIT_MS && q5.startMs <= START_LIMIT_MS, applicable: true, ...q5 },
      minSizePct: minSize,
      sizeCurve,
      rateByKindAtOrAbove12: Object.fromEntries(
        kinds.map((k) => [
          k,
          round(
            rateOf((c) => c.size >= Q3_MIN_SIZE && c.kind === k),
            3
          )
        ])
      )
    }
  }
  // single stages, for the size-curve and timing detail
  const stageNames = ['zxing:full', 'zxing:region', 'wechat:full', 'wechat:region']
  const stages = Object.fromEntries(
    stageNames.map((sn) => {
      const rate = (pred: (c: Code) => boolean) => {
        let h = 0
        let n = 0
        for (const c of plan)
          if (pred(c))
            for (const f of fs.filter((x) => x.slide === c.slide)) (n++, f.stages.get(sn)!.texts.includes(c.url) && h++)
        return n ? round(h / n, 3) : null
      }
      const ms = fs.map((f) => f.stages.get(sn)!.ms)
      return [
        sn,
        {
          p50Ms: round(pct(ms, 50)),
          p95Ms: round(pct(ms, 95)),
          rateBySize: Object.fromEntries(sizes.map((s) => [s, rate((c) => c.size === s)])),
          rateBySizeAndKind: Object.fromEntries(
            sizes.map((s) => [s, Object.fromEntries(kinds.map((k) => [k, rate((c) => c.size === s && c.kind === k)]))])
          )
        }
      ]
    })
  )
  return { conditions: conds, frames: fs.length, pipelines: out, stages }
}

const main = evaluateSet(args.main!.split(','))
const stress = args.stress ? evaluateSet(args.stress.split(',')) : null

type Pipe = {
  Q1: { pass: boolean }
  Q2: { pass: boolean }
  Q3: { pass: boolean }
  Q4: { pass: boolean; p95Ms: number }
  Q5: { pass: boolean }
  minSizePct: number | null
}
const pipes = main.pipelines as Record<string, Pipe>
const order = ['zxing', 'wechat', 'both']
const all = order.filter((p) => ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].every((q) => pipes[p][q as 'Q1'].pass))
let decoder: string | null = null
let basis = ''
if (all.length) {
  decoder = all[0]
  basis = 'first pipeline passing Q1 to Q5'
} else {
  const safe = order.filter((p) => pipes[p].Q1.pass && pipes[p].Q4.pass && pipes[p].Q5.pass)
  const ranked = safe
    .filter((p) => pipes[p].minSizePct !== null)
    .sort((a, b) => pipes[a].minSizePct! - pipes[b].minSizePct! || order.indexOf(a) - order.indexOf(b))
  decoder = ranked[0] ?? null
  basis = decoder
    ? 'no pipeline passes Q1 to Q5; chosen for the smallest passing size among those passing Q1, Q4 and Q5'
    : 'no pipeline passes Q1, Q4 and Q5 with a passing size'
}
const chosen = decoder ? pipes[decoder] : null
const summary = {
  generatedFor: 'plan 00 task 3 (synthetic frames)',
  thresholds: {
    acceptWithinSec: ACCEPT_WITHIN,
    q2SizePct: Q2_SIZE,
    q3MinSizePct: Q3_MIN_SIZE,
    q3Rate: 0.9,
    p95Ms: P95_LIMIT_MS,
    bridgeP95Ms: BRIDGE_LIMIT_MS,
    startMs: START_LIMIT_MS
  },
  decision: {
    'qr.decoder': decoder,
    'qr.minSizePct': chosen?.minSizePct ?? null,
    'qr.p95Ms': chosen?.Q4.p95Ms ?? null,
    basis
  },
  main,
  stress
}
writeFileSync(args.out!, JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary.decision))
