import { errors, type Page } from 'playwright'
import type { FormProvider } from '@tm/core'

const DEFAULT_URLS: Record<FormProvider, string> = {
  google: 'https://docs.google.com/forms/u/0/',
  microsoft: 'https://forms.office.com/'
}

const SIGNIN_HOSTS = new Set(['accounts.google.com', 'login.microsoftonline.com', 'login.live.com'])
const LOAD_TIMEOUT_MS = 15_000
const SIGNIN_FIELDS = 'input[type=email], input[type=password]'

// Returns the providers whose forms page asks the desk to sign in. A timed-out load counts as signed out.
export async function checkFormProviders(
  desk: Page,
  providers: FormProvider[],
  opts: { urls?: Partial<Record<FormProvider, string>> } = {}
): Promise<FormProvider[]> {
  const signedOut: FormProvider[] = []
  for (const provider of providers) {
    const url = opts.urls?.[provider] ?? DEFAULT_URLS[provider]
    if (await isSignedOut(desk, url)) signedOut.push(provider)
  }
  return signedOut
}

async function isSignedOut(desk: Page, url: string): Promise<boolean> {
  try {
    await desk.goto(url, { timeout: LOAD_TIMEOUT_MS, waitUntil: 'load' })
  } catch (err) {
    if (err instanceof errors.TimeoutError) return true
    throw err
  }
  if (SIGNIN_HOSTS.has(new URL(desk.url()).hostname)) return true
  return (await desk.locator(SIGNIN_FIELDS).filter({ visible: true }).count()) > 0
}
