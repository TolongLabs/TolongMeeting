import { join } from 'node:path'

const root = join(import.meta.dir, '..')

/**
 * Bundles the main process into one CommonJS file (`.cjs`, because the package is an ES module package) with the
 * server address built in. `electron` stays external.
 */
async function build(outdir: string, publicUrl: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, 'src/main/index.ts')],
    root: join(root, 'src'),
    outdir,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    naming: '[dir]/[name].cjs',
    define: { TM_PUBLIC_URL: JSON.stringify(publicUrl) }
  })
  if (!result.success) throw new AggregateError(result.logs, 'the companion build failed')
}

// `bun scripts/build.ts [outdir]`
if (import.meta.main) {
  const publicUrl = process.env.TM_PUBLIC_URL
  if (!publicUrl) throw new Error('TM_PUBLIC_URL is not set: it is the default server address built into the app')
  await build(process.argv[2] ?? join(root, 'dist'), publicUrl)
}
