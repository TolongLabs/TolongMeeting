import { defineConfig } from '@playwright/test'
import { OPS_PORT } from './test/e2e-ops/state'

const port = OPS_PORT

// Browser tests for the Devices, Connections and Admin pages. `test/e2e-ops/serve.ts` makes a scratch database with three
// seeded members, starts fake GitHub, Google and Notion servers, builds the site, starts it on `port` with the fakes
// wired in, and writes the members' session cookies to a state file the spec reads. Run them with
// `TEST_DATABASE_URL=postgres://... bunx playwright test -c packages/web/playwright.ops.config.ts`.
export default defineConfig({
  testDir: 'test/e2e-ops',
  testMatch: '*.spec.ts',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `bun test/e2e-ops/serve.ts ${port}`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: Boolean(process.env.TM_OPS_REUSE),
    timeout: 300_000
  }
})
