import { defineConfig } from '@playwright/test'

const port = 4791

// Page tests for the website. `test/e2e/serve.ts` makes a scratch database with two seeded members, builds the site,
// starts it on `port` and writes the members' session cookies to a state file the specs read. Run them with
// `TEST_DATABASE_URL=postgres://... bunx playwright test -c packages/web/playwright.config.ts`.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `bun test/e2e/serve.ts ${port}`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 300_000
  }
})
