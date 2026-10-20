import { cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
/** The repository whose images a PC may run when the build names none. */
const DEFAULT_IMAGE_PREFIX = 'ghcr.io/tolonglabs/'

const PAGES = ['pairing', 'settings', 'signin']

async function bundle(config: Bun.BuildConfig): Promise<void> {
  const result = await Bun.build(config)
  if (!result.success) throw new AggregateError(result.logs, 'the companion build failed')
}

/**
 * Builds the app into `outdir`:
 *  - `main/index.cjs`: the main process, one CommonJS file (`.cjs`, because the package is an ES module package) with
 *    the server address and the trusted worker image repository built in (`TM_WORKER_IMAGE_PREFIX`, default
 *    `ghcr.io/tolonglabs/`: a PC pulls and runs no image outside it). `electron` stays external. `extraMain` adds more
 *    main-process entry files next to it (the Electron smoke test's window harness).
 *  - `preload/<page>.cjs`: one small preload per window, with only `electron` required.
 *  - `renderer/`: each page's HTML and stylesheet as they are, and its script as a plain browser script. The pages
 *    allow scripts from their own files only, so nothing is inline.
 */
export async function build(
  outdir: string,
  publicUrl: string,
  imagePrefix: string,
  extraMain: string[] = []
): Promise<void> {
  await bundle({
    entrypoints: [join(root, 'src/main/index.ts')],
    root: join(root, 'src'),
    outdir,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    naming: '[dir]/[name].cjs',
    define: { TM_PUBLIC_URL: JSON.stringify(publicUrl), TM_WORKER_IMAGE_PREFIX: JSON.stringify(imagePrefix) }
  })
  if (extraMain.length > 0) {
    await bundle({
      entrypoints: extraMain,
      outdir,
      target: 'node',
      format: 'cjs',
      external: ['electron'],
      naming: 'main/[name].cjs',
      define: { TM_PUBLIC_URL: JSON.stringify(publicUrl), TM_WORKER_IMAGE_PREFIX: JSON.stringify(imagePrefix) }
    })
  }
  await bundle({
    entrypoints: PAGES.map((page) => join(root, 'src/preload', `${page}.ts`)),
    root: join(root, 'src'),
    outdir,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    naming: '[dir]/[name].cjs'
  })
  await bundle({
    entrypoints: PAGES.map((page) => join(root, 'src/renderer', `${page}.ts`)),
    root: join(root, 'src'),
    outdir,
    target: 'browser',
    format: 'iife',
    naming: '[dir]/[name].js'
  })
  for (const file of await readdir(join(root, 'src/renderer'))) {
    if (file.endsWith('.html') || file.endsWith('.css'))
      await cp(join(root, 'src/renderer', file), join(outdir, 'renderer', file))
  }
}

// `bun scripts/build.ts [outdir [extra main entry files...]]`
if (import.meta.main) {
  const publicUrl = process.env.TM_PUBLIC_URL
  if (!publicUrl) throw new Error('TM_PUBLIC_URL is not set: it is the default server address built into the app')
  await build(
    process.argv[2] ?? join(root, 'dist'),
    publicUrl,
    process.env.TM_WORKER_IMAGE_PREFIX ?? DEFAULT_IMAGE_PREFIX,
    process.argv.slice(3)
  )
}
