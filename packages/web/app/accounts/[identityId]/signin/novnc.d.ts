// The parts of noVNC's `RFB` that the viewer uses (https://github.com/novnc/noVNC/blob/master/docs/API.md). The package
// ships no types.
declare module '@novnc/novnc' {
  export interface RfbOptions {
    shared?: boolean
    credentials?: { username?: string; password?: string; target?: string }
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions)
    /** Scales the remote screen to fit its container. */
    scaleViewport: boolean
    disconnect(): void
    focus(): void
  }
}
