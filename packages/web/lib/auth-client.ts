import { createAuthClient } from 'better-auth/react'

/** Better Auth in the browser, on this site's own `/api/auth`. Only the sign-in button uses it. */
export const authClient = createAuthClient()
