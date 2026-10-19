// Exports finalized Archify diagrams as transparent dual-theme SVGs for the docs.
//
//   bun run diagrams                  export every candidate in docs/images/diagrams/src
//   bun run diagrams <name> [<name>]  export only these diagrams
//   bun run diagrams --finalize ...   run `archify finalize` on each candidate first
//
// A candidate `src/<name>.<type>.json` is finalized to `.archify/<name>/<name>.html` and exported to
// `docs/images/diagrams/<name>.svg`. The Archify CLI path comes from ARCHIFY_CLI.
import { chromium } from 'playwright'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const srcDir = join(root, 'docs/images/diagrams/src')
const outDir = join(root, 'docs/images/diagrams')
const archifyCli = process.env.ARCHIFY_CLI ?? join(homedir(), '.claude/skills/archify/bin/archify.mjs')

// The exported SVG paints a theme background and a grid over it. Both rules go, so the image takes the page's background.
const REWRITES = [
  ['rect.c-bg-rect { fill: var(--bg); }', 'rect.c-bg-rect { fill: none; }'],
  ['.c-grid { stroke: var(--grid); fill: none; }', '.c-grid { stroke: none; fill: none; }']
] as const

interface Candidate {
  name: string
  type: string
  json: string
  html: string
}

async function candidates(): Promise<Candidate[]> {
  const files = (await readdir(srcDir)).filter((f) => f.endsWith('.json')).sort()
  return files.map((f) => {
    const [name, type] = basename(f, '.json').split('.')
    if (!name || !type) throw new Error(`Candidate ${f} must be named <name>.<type>.json`)
    return { name, type, json: join(srcDir, f), html: join(root, '.archify', name, `${name}.html`) }
  })
}

function finalize(c: Candidate): void {
  rmSync(join(root, '.archify', c.name), { recursive: true, force: true }) // stale receipts make archify refuse to run
  const proc = Bun.spawnSync(
    ['node', archifyCli, 'finalize', c.type, c.json, c.html, '--quality', 'showcase', '--json'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  )
  if (proc.exitCode !== 0) {
    throw new Error(`archify finalize failed for ${c.name} (exit ${proc.exitCode}):\n${proc.stdout}\n${proc.stderr}`)
  }
  console.log(`finalized ${c.name}`)
}

export function makeTransparent(svg: string, name: string): string {
  let out = svg
  for (const [from, to] of REWRITES) {
    const count = out.split(from).length - 1
    if (count !== 1) throw new Error(`${name}: expected exactly one "${from}" rule in the exported SVG, found ${count}`)
    out = out.replace(from, to)
  }
  if (!out.includes('class="c-bg-rect"')) throw new Error(`${name}: exported SVG has no c-bg-rect element`)
  return out
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const doFinalize = args.includes('--finalize')
  const names = args.filter((a) => !a.startsWith('--'))
  const all = await candidates()
  const selected = names.length ? all.filter((c) => names.includes(c.name)) : all
  const unknown = names.filter((n) => !all.some((c) => c.name === n))
  if (unknown.length) throw new Error(`Unknown diagram name(s): ${unknown.join(', ')}`)

  if (doFinalize) selected.forEach(finalize)
  for (const c of selected) {
    if (!existsSync(c.html)) throw new Error(`${c.html} is missing; run with --finalize first`)
  }

  await mkdir(outDir, { recursive: true })
  const browser = await chromium.launch()
  try {
    for (const c of selected) {
      const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } })
      const page = await context.newPage()
      await page.goto(`file://${c.html}`)
      await page.locator('#btn-export').click()
      const download = page.waitForEvent('download')
      await page.locator('#export-menu button[data-format="svg"]').click()
      const path = await (await download).path()
      const svg = await Bun.file(path).text()
      const target = join(outDir, `${c.name}.svg`)
      await writeFile(target, makeTransparent(svg, c.name))
      console.log(`exported ${target} (${(svg.length / 1024).toFixed(0)} KiB)`)
      await context.close()
    }
  } finally {
    await browser.close()
  }
}

await main()
