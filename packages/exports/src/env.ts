// The environment of the `tm-exports` process, checked once at start-up. An error names variables only: a value can be a
// password, a secret or a path to one.

/** A start-up refusal. Its message holds variable names, never a value. */
export class EnvError extends Error {
  constructor(readonly names: string[]) {
    super(`Missing or invalid environment variables: ${names.join(', ')}`)
    this.name = 'EnvError'
  }
}

export interface ExportsEnv {
  databaseUrl: string
  /** `TM_DATA_ROOT`: occurrence directories are under `<dataRoot>/occurrences/<id>`. */
  dataRoot: string
  /** The origin of `TM_PUBLIC_URL`: no path, no trailing slash. */
  publicUrl: string
  ntfyUrl: string
  masterKeyFile: string
}

const isUrl = (value: string, protocols: string[]): boolean => {
  const url = URL.parse(value)
  return url !== null && protocols.includes(url.protocol)
}

/** A bare origin (`https://tm.example`): http or https, no credentials, path, query or fragment. */
const isOrigin = (value: string): boolean => {
  const url = URL.parse(value)
  return (
    url !== null &&
    ['http:', 'https:'].includes(url.protocol) &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !value.endsWith('/')
  )
}

const CHECKS: Record<string, (value: string) => boolean> = {
  DATABASE_URL: (v) => isUrl(v, ['postgres:', 'postgresql:']),
  TM_DATA_ROOT: (v) => v.startsWith('/') && v !== '/' && !v.split('/').includes('..'),
  TM_PUBLIC_URL: isOrigin,
  NTFY_URL: isOrigin,
  TM_MASTER_KEY_FILE: (v) => v.startsWith('/')
}

/** Each OAuth client is two variables that go together; one without the other is a mistake, not "off". */
const OAUTH_PAIRS = [
  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  ['NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET']
] as const

/** Reads and checks the variables of `tm-exports`. Every bad or missing one is named in one `EnvError`. */
export function readExportsEnv(source: Record<string, string | undefined>): ExportsEnv {
  const bad = Object.entries(CHECKS)
    .filter(([name, ok]) => {
      const value = source[name]
      return value === undefined || value === '' || !ok(value)
    })
    .map(([name]) => name)
  for (const pair of OAUTH_PAIRS) {
    const set = pair.filter((name) => source[name] !== undefined && source[name] !== '')
    if (set.length === 1) bad.push(...pair.filter((name) => !set.includes(name)))
  }
  if (bad.length > 0) throw new EnvError(bad)
  const v = (name: string) => source[name]!
  return {
    databaseUrl: v('DATABASE_URL'),
    dataRoot: v('TM_DATA_ROOT'),
    publicUrl: v('TM_PUBLIC_URL'),
    ntfyUrl: v('NTFY_URL'),
    masterKeyFile: v('TM_MASTER_KEY_FILE')
  }
}
