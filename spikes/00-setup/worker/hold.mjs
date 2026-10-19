import { mkdirSync, writeFileSync } from 'node:fs'
import { launchSpikeBrowser } from './browser.mjs'

const stageUrl = []
const deskUrls = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i] === '--stage-url') stageUrl.push(argv[i + 1])
  else if (argv[i] === '--desk-url') deskUrls.push(argv[i + 1])
  else throw new Error(`unknown option ${argv[i]}`)
}
if (stageUrl.length !== 1) throw new Error('exactly one --stage-url required')

const { context } = await launchSpikeBrowser({
  stageUrl: stageUrl[0],
  deskUrls: deskUrls.length ? deskUrls : undefined
})
const browser = context.browser()
mkdirSync('/data/results', { recursive: true })
writeFileSync(
  `/data/results/hold-${new Date().toISOString()}.json`,
  JSON.stringify({ chrome: browser.version(), node: process.version, ...context.tmBounds }, null, 2)
)
console.log('holding')
process.on('SIGTERM', async () => {
  await context.close()
  process.exit(0)
})
await new Promise(() => {})
