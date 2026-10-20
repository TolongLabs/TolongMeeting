/** The part of Electron's `powerSaveBlocker` this app uses. */
export interface PowerBlockerLike {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

/**
 * Keeps the PC awake while a native job or a local meeting runs. Reference counted: the OS gets one request while
 * anything holds it, and it is dropped when the last holder lets go. It asks the OS not to suspend the app and never
 * changes a power setting.
 */
export class KeepAwake {
  private blockerId: number | null = null
  private readonly holders = new Map<symbol, string>()

  constructor(private readonly blocker: PowerBlockerLike) {}

  /** Why each current holder wants the PC awake. */
  get active(): string[] {
    return [...this.holders.values()]
  }

  /** Holds the PC awake until the returned function is called. Calling it again does nothing. */
  acquire(reason: string): () => void {
    if (this.blockerId === null) this.blockerId = this.blocker.start('prevent-app-suspension')
    const holder = Symbol(reason)
    this.holders.set(holder, reason)
    return () => {
      if (!this.holders.delete(holder)) return
      if (this.holders.size === 0 && this.blockerId !== null) {
        const id = this.blockerId
        this.blockerId = null
        this.blocker.stop(id)
      }
    }
  }
}
