import { expect, test } from 'bun:test'
import { buildTargets, oauthClientFromEnv } from '../src/registry'

test('downloads and GitHub are always there; the other remote targets need their client', () => {
  expect(Object.keys(buildTargets({ google: null, notion: null })).sort()).toEqual(['github', 'pdf', 'zip'])
  expect(
    oauthClientFromEnv('google', {
      TM_PUBLIC_URL: 'https://tm.example',
      GOOGLE_CLIENT_ID: 'a',
      GOOGLE_CLIENT_SECRET: 'b'
    })
  ).toEqual({
    clientId: 'a',
    clientSecret: 'b',
    redirectUri: 'https://tm.example/api/connections/google/callback'
  })
  expect(
    oauthClientFromEnv('notion', {
      TM_PUBLIC_URL: 'https://tm.example',
      NOTION_CLIENT_ID: 'a'
    })
  ).toBeNull()
})

test('the Google redirect address is built from the validated origin, whatever the trailing slash', () => {
  const env = { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }
  expect(oauthClientFromEnv('google', { ...env, TM_PUBLIC_URL: 'https://tm.example/' })?.redirectUri).toBe(
    'https://tm.example/api/connections/google/callback'
  )
  for (const bad of ['https://tm.example/app', 'http://tm.example', 'https://u:p@tm.example', 'tm.example'])
    expect(() => oauthClientFromEnv('google', { ...env, TM_PUBLIC_URL: bad })).toThrow('TM_PUBLIC_URL must be')
})

test('an empty variable counts as unset (Compose passes unset variables as empty)', () => {
  expect(
    oauthClientFromEnv('notion', {
      TM_PUBLIC_URL: 'https://tm.example',
      NOTION_CLIENT_ID: '',
      NOTION_CLIENT_SECRET: ''
    })
  ).toBeNull()
})

test('a client without TM_PUBLIC_URL is refused, naming the variable only', () => {
  expect(() => oauthClientFromEnv('google', { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' })).toThrow(
    'TM_PUBLIC_URL is not set'
  )
})
