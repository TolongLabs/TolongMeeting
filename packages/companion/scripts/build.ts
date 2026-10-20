import { join } from 'node:path'

const root = join(import.meta.dir, '..')
/** The repository whose images a PC may run when the build names none. */
const DEFAULT_IMAGE_PREFIX = 'ghcr.io/tolonglabs/'

/**
 * Bundles the main process into one CommonJS file (`.cjs`, because the package is an ES module package) with the
 * server address and the trusted worker image repository built in (`TM_WORKER_IMAGE_PREFIX`, default
 * `ghcr.io/tolonglabs/`: a PC pulls and runs no image outside it). `electron` stays external.
 */
async function build(outdir: string, publicUrl: string, imagePrefix: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, 'src/main/index.ts')],
    root: join(root, 'src'),
    outdir,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    naming: '[dir]/[name].cjs',
    define: { TM_PUBLIC_URL: JSON.stringify(publicUrl), TM_WORKER_IMAGE_PREFIX: JSON.stringify(imagePrefix) }
  })
  if (!result.success) throw new AggregateError(result.logs, 'the companion build failed')
}

// `bun scripts/build.ts [outdir]`
if (import.meta.main) {
  const publicUrl = process.env.TM_PUBLIC_URL
  if (!publicUrl) throw new Error('TM_PUBLIC_URL is not set: it is the default server address built into the app')
  await build(
    process.argv[2] ?? join(root, 'dist'),
    publicUrl,
    process.env.TM_WORKER_IMAGE_PREFIX ?? DEFAULT_IMAGE_PREFIX
  )
}
