import type { Rect } from './adapters/types'

export interface Stopper {
  stop(): Promise<void>
}

// The virtual X display: stage (left half, recorded) and desk (right half, never recorded).
export interface Screen {
  display: string
  width: 3840
  height: 1080
  stage: Rect
  desk: Rect
  stop(): Promise<void>
}
