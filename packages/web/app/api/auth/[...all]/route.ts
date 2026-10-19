import { toNextJsHandler } from 'better-auth/next-js'
import { getAuth } from '../../../../lib/auth'

// Built per request from the lazy instance, so importing this route needs no secrets (`next build`).
export function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).GET(request)
}

export function POST(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).POST(request)
}
