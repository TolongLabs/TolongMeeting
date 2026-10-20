interface Deferred {
  promise: Promise<string>
  resolve(url: string): void
}

function deferred(): Deferred {
  let resolve!: (url: string) => void
  const promise = new Promise<string>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

export interface LinkOverrideOptions {
  /** The link rule: the clean URL, or null for a link the worker refuses. Default: every link is taken as it is. */
  normalise?: (url: string) => string | null
  /** Called (without the URL, which may hold a passcode) for each pasted link the rule refuses. */
  onRefused?: () => void
}

/**
 * The link the member pasted on the website, as the heartbeat replies bring it. A pasted link wins over every other
 * source until joining starts. A link the rule refuses is dropped and reported; the same link offered again changes
 * nothing.
 */
export class LinkOverride {
  private latest: string | null = null
  private refused: string | null = null
  private waiters: Deferred = deferred()

  constructor(private readonly opts: LinkOverrideOptions = {}) {}

  offer(url: string | null): void {
    if (url === null || url === this.latest || url === this.refused) return
    const clean = this.opts.normalise ? this.opts.normalise(url) : url
    if (clean === null) {
      this.refused = url
      this.opts.onRefused?.()
      return
    }
    if (clean === this.latest) return
    this.latest = clean
    const waiting = this.waiters
    this.waiters = deferred()
    waiting.resolve(clean)
  }

  current(): string | null {
    return this.latest
  }

  /** Resolves with the first link offered after this call. Callers before the next link share one promise. */
  next(): Promise<string> {
    return this.waiters.promise
  }
}
