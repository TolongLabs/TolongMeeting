import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const port = 4780

// The adapters read their selector maps from TM_SELECTORS_DIR; tests use the repository's maps.
process.env.TM_SELECTORS_DIR ??= resolve(here, '../../config/selectors')

export default defineConfig({
  testDir: 'test',
  testMatch: '*.spec.ts',
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `node ${resolve(here, 'test/support/fixture-server.mjs')} ${port}`,
    url: `http://localhost:${port}/fixture.js`,
    reuseExistingServer: true
  }
})
