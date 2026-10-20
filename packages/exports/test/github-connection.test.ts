import { expect, test } from 'bun:test'
import { normaliseRepoFolder, saveGitHubConnection } from '../src/connections/github'
import type { Connection } from '../src/types'
import { json, routeFetch, type Route } from './route-fetch'

test('normaliseRepoFolder', () => {
  expect(normaliseRepoFolder(' /docs/meetings/ ')).toBe('docs/meetings')
  expect(normaliseRepoFolder('docs\\meetings//2026')).toBe('docs/meetings/2026')
  expect(normaliseRepoFolder('./a/./b')).toBe('a/b')
  expect(normaliseRepoFolder('')).toBe('')
  expect(normaliseRepoFolder('docs/meetings\n')).toBe('docs/meetings')
  for (const bad of [
    'docs/../x',
    '..',
    '.git/hooks',
    'a/.git',
    'a/.GIT/b',
    '..\\x',
    'a/\u0000b',
    '.git.',
    'a/.git..',
    'a/GIT~1/b',
    'git~1.',
    'a\u200Bb',
    '.git\u200B',
    'x/\u202E',
    'a/\uFEFFb'
  ])
    expect(() => normaliseRepoFolder(bad)).toThrow('Use a folder path inside the repository, without ".." or ".git".')
})

const REPO = 'https://api.github.com/repos/acme/notes'
const base = { owner: 'acme', repo: 'notes', branch: 'main', folder: 'meetings' }
const TOKEN = 'github_pat_secret123'

function github(over: { repo?: number; branch?: number } = {}) {
  const routes: Route[] = [
    ['GET', REPO, () => json({}, over.repo ?? 200)],
    ['GET', `${REPO}/branches/main`, () => json({}, over.branch ?? 200)]
  ]
  return routeFetch(routes)
}

function setup(stored?: Connection) {
  const saved: Connection[] = []
  const connections = {
    async get() {
      return stored ? { connection: stored, status: 'ok' as const } : null
    },
    async save(c: Connection) {
      saved.push(c)
    }
  }
  const save = (body: unknown, f = github()) =>
    saveGitHubConnection(typeof body === 'string' ? body : JSON.stringify(body), { connections, http: f.fetch })
  return { save, saved }
}

test('saving checks the token and the repository', async () => {
  const { save, saved } = setup()
  expect(await save({ ...base, token: 'ghp_classic' })).toEqual({
    status: 400,
    body: {
      error: 'invalid_settings',
      message: 'Use a fine-grained token (it starts with github_pat_) limited to this repository.'
    }
  })
  expect((await save({ ...base, token: TOKEN }, github({ repo: 404 }))).body).toMatchObject({
    message: "This token can't see acme/notes. Give it access to that repository."
  })
  expect((await save({ ...base, token: TOKEN }, github({ branch: 404 }))).body).toMatchObject({
    message: "Branch main doesn't exist in acme/notes."
  })
  expect((await save({ ...base, token: TOKEN }, github({ repo: 401 }))).body).toMatchObject({
    message: 'GitHub rejected this token.'
  })
  expect((await save({ ...base, token: TOKEN }, github({ repo: 500 }))).status).toBe(502)
  expect(saved).toEqual([])
  const ok = await save({ ...base, token: TOKEN, folder: ' /meetings/ ' })
  expect(ok.status).toBe(200)
  expect(saved).toEqual([{ kind: 'github', token: TOKEN, ...base }])
  expect(JSON.stringify(ok)).not.toContain(TOKEN)
})

test('a token left out keeps the stored one; none stored is refused', async () => {
  const stored: Connection = { kind: 'github', token: 'github_pat_old', ...base }
  const kept = setup(stored)
  const f = github()
  expect((await kept.save({ ...base, branch: 'main' }, f)).status).toBe(200)
  expect(kept.saved[0]).toMatchObject({ token: 'github_pat_old' })
  expect(f.call('GET', REPO).headers.authorization).toBe('Bearer github_pat_old')
  const none = setup()
  const g = github()
  expect((await none.save({ ...base }, g)).status).toBe(400)
  expect(g.calls).toEqual([])
})

test('owner, repository, branch and folder are validated before any request', async () => {
  const { save, saved } = setup()
  const f = github()
  for (const bad of [
    { owner: '..' },
    { repo: '..' },
    { repo: 'a/b' },
    { owner: 'a b' },
    { branch: '../main' },
    { branch: '/main' },
    { branch: 'a..b' },
    { branch: 'x.lock' },
    { folder: '../x' },
    { folder: 'a/.git' }
  ]) {
    const r = await save({ ...base, token: TOKEN, ...bad }, f)
    expect(r.status).toBe(400)
  }
  expect((await save('not json', f)).status).toBe(400)
  expect((await save({ ...base, token: TOKEN, extra: 1 }, f)).status).toBe(400)
  expect(f.calls).toEqual([])
  expect(saved).toEqual([])
})

test('only api.github.com is called, without redirects, and the token only in the Authorization header', async () => {
  const { save } = setup()
  const f = github()
  await save({ ...base, branch: 'main', token: TOKEN }, f)
  expect(f.calls).toHaveLength(2)
  for (const call of f.calls) {
    expect(new URL(call.url).origin).toBe('https://api.github.com')
    expect(call.redirect).toBe('error')
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(call.headers['x-github-api-version']).toBe('2022-11-28')
    expect(call.headers['user-agent']).toBe('TolongMeeting')
    expect(call.url).not.toContain(TOKEN)
    expect(call.body).not.toContain(TOKEN)
  }
})
