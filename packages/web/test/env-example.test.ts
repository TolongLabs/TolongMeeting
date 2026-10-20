import { join } from 'node:path'
import { expect, test } from 'bun:test'

// The repository root, whatever the directory `bun test` runs from.
const example = join(import.meta.dir, '..', '..', '..', '.env.example')

test('.env.example names every variable and holds no values', async () => {
  const lines = (await Bun.file(example).text()).split('\n').filter((l) => l && !l.startsWith('#'))
  expect(lines.map((l) => l.split('=')[0]).sort()).toEqual([
    'DATABASE_URL',
    'DOCKER_PROXY_URL',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_ORG',
    'NTFY_ADMIN_TOKEN',
    'NTFY_URL',
    'POSTGRES_PASSWORD',
    'TM_BACKUP_REMOTE',
    'TM_DATA_ROOT',
    'TM_MASTER_KEY_FILE',
    'TM_PROFILE_ROOT',
    'TM_PUBLIC_URL',
    'TM_SELECTORS_DIR'
  ])
  expect(lines.every((l) => l.endsWith('='))).toBe(true)
})
