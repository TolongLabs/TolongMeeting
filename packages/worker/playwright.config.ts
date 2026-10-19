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
  projects: [
    // HTML fixtures served by test/support/fixture-server.mjs (all specs outside test/image and test/host).
    { name: 'fixtures', testIgnore: ['**/image/**', '**/host/**'], use: { baseURL: `http://localhost:${port}` } },
    // Needs the worker image (Xvfb, openbox, Chrome, PulseAudio); the specs skip unless TM_IN_IMAGE=1.
    { name: 'image', testMatch: 'image/*.spec.ts' },
    // Launch proof for a host with Xvfb and Chrome but no openbox; the spec skips unless TM_HOST_LAUNCH=1.
    { name: 'host', testMatch: 'host/*.spec.ts' }
  ],
  webServer: {
    command: `node ${resolve(here, 'test/support/fixture-server.mjs')} ${port}`,
    url: `http://localhost:${port}/fixture.js`,
    reuseExistingServer: true
  }
})
