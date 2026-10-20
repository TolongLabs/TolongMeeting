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
    'GOOGLE_API_KEY',
    'GOOGLE_APP_ID',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'NOTION_CLIENT_ID',
    'NOTION_CLIENT_SECRET',
    'NTFY_ADMIN_TOKEN',
    'NTFY_URL',
    'POSTGRES_PASSWORD',
    'TM_BACKUP_REMOTE',
    'TM_DATA_ROOT',
    'TM_MASTER_KEY_FILE',
    'TM_PROFILE_ROOT',
    'TM_PUBLIC_URL',
    'TM_TAILSCALE_CLIENT_ID',
    'TM_TAILSCALE_CLIENT_SECRET',
    'TM_WORKER_IMAGE_REF'
  ])
  expect(lines.every((l) => l.endsWith('='))).toBe(true)
})
