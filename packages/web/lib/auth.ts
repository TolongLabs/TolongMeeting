import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { deriveKey } from '@tm/core'
import * as authSchema from '../db/auth-schema'
import { getDb, type Db } from '../db/index'
import { loadMasterKey } from '../db/secrets'
import { authoriseSession } from './authorise'
import { githubApi, type GitHubApi } from './github'
import { authScope } from './scope'

export interface AuthOptions {
  db: Db
  /** The 32-byte master key; the session secret is derived from it. */
  master: Buffer
  publicUrl: string
  clientId: string
  clientSecret: string
  org: string
  github?: GitHubApi
}

/**
 * Better Auth with GitHub as the only way in: no email or password, and no session unless `authoriseSession` allows it.
 * Cookies are httpOnly, secure and same-site lax. The `read:org` scope lets us ask GitHub whether the user is in the
 * organisation (at sign-in, and daily from the scheduler).
 */
export function createAuth(options: AuthOptions) {
  const { db, publicUrl, clientId, clientSecret, org } = options
  const deps = { github: options.github ?? githubApi(), auth: authScope(db), org }
  return betterAuth({
    baseURL: publicUrl,
    secret: deriveKey(options.master, 'better-auth').toString('base64'),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: authSchema
    }),
    user: { modelName: 'auth_user' },
    session: { modelName: 'auth_session' },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    socialProviders: { github: { clientId, clientSecret, scope: ['read:org'] } },
    advanced: { useSecureCookies: true, defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' } },
    onAPIError: { errorURL: '/sign-in' },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            await authoriseSession(deps, session.userId)
          }
        }
      }
    }
  })
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

let current: ReturnType<typeof createAuth> | undefined

/**
 * The process-wide auth instance, built on first use from `TM_PUBLIC_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
 * `GITHUB_ORG`, `TM_MASTER_KEY_FILE` and `DATABASE_URL`. Built lazily so `next build` doesn't need the secrets.
 */
export function getAuth(): ReturnType<typeof createAuth> {
  current ??= createAuth({
    db: getDb(),
    master: loadMasterKey(),
    publicUrl: required('TM_PUBLIC_URL'),
    clientId: required('GITHUB_CLIENT_ID'),
    clientSecret: required('GITHUB_CLIENT_SECRET'),
    org: required('GITHUB_ORG')
  })
  return current
}
