import { defineConfig } from '@playwright/test'

const port = 4792

// Browser tests for the settings pages (My details, Notifications, AI keys). `test/e2e-settings/serve.ts` makes a scratch
// database with one seeded member, fakes for ntfy and the AI providers, builds the site and starts it on `port`. Run them with
// `TEST_DATABASE_URL=postgres://... bunx playwright test -c packages/web/playwright.settings.config.ts`.
export default defineConfig({
  testDir: 'test/e2e-settings',
  testMatch: '*.spec.ts',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `bun test/e2e-settings/serve.ts ${port}`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 300_000
  }
})
