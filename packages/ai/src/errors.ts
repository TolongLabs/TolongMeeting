export class AiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AiError'
    this.status = status
  }
}

// The provider rejected the member's key or account: bad key, no balance, or rate limit.
export class AiKeyError extends AiError {
  declare status: 401 | 402 | 429

  constructor(status: 401 | 402 | 429, message: string) {
    super(message, status)
    this.name = 'AiKeyError'
  }
}

export class AiTimeoutError extends Error {
  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(`AI request timed out after ${timeoutMs} ms`, options)
    this.name = 'AiTimeoutError'
  }
}
