import { expect, test } from 'bun:test'
import { EnvError, readExportsEnv } from '../src/env'

const good = {
  DATABASE_URL: 'postgres://tm:pw@postgres:5432/tm',
  TM_DATA_ROOT: '/srv/tolongmeeting/data',
  TM_PUBLIC_URL: 'https://tm.example',
  NTFY_URL: 'https://ntfy.tm.example',
  TM_MASTER_KEY_FILE: '/run/secrets/tm_master_key'
}

test('a good environment is read; the OAuth variables are optional', () => {
  expect(readExportsEnv(good)).toEqual({
    databaseUrl: good.DATABASE_URL,
    dataRoot: good.TM_DATA_ROOT,
    publicUrl: good.TM_PUBLIC_URL,
    ntfyUrl: good.NTFY_URL,
    masterKeyFile: good.TM_MASTER_KEY_FILE
  })
  expect(
    readExportsEnv({ ...good, GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', NOTION_CLIENT_ID: '' })
  ).toBeTruthy()
})

test('every bad variable is named once, and no value is in the message', () => {
  const err = (() => {
    try {
      readExportsEnv({
        ...good,
        DATABASE_URL: 'mysql://user:hunter2@db/tm',
        TM_PUBLIC_URL: 'https://tm.example/',
        NTFY_URL: undefined,
        TM_DATA_ROOT: '../secret-path'
      })
    } catch (e) {
      return e
    }
  })()
  expect(err).toBeInstanceOf(EnvError)
  expect((err as EnvError).names).toEqual(['DATABASE_URL', 'TM_DATA_ROOT', 'TM_PUBLIC_URL', 'NTFY_URL'])
  expect((err as Error).message).toBe(
    'Missing or invalid environment variables: DATABASE_URL, TM_DATA_ROOT, TM_PUBLIC_URL, NTFY_URL'
  )
})

test('half of an OAuth client is an error: the missing half is named', () => {
  expect(() => readExportsEnv({ ...good, NOTION_CLIENT_ID: 'a' })).toThrow(
    'Missing or invalid environment variables: NOTION_CLIENT_SECRET'
  )
  expect(() => readExportsEnv({ ...good, GOOGLE_CLIENT_SECRET: 'b' })).toThrow(
    'Missing or invalid environment variables: GOOGLE_CLIENT_ID'
  )
})
