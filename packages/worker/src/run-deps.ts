import { sendPing } from '@tm/notify'
import { adapterFor } from './adapters'
import { startLiveAsr } from './asr/live'
import { startAudioSource } from './audio/source'
import { startChatCapture } from './chat/capture'
import { launchBrowser, launchGuestStage } from './chrome/launch'
import { startScreen } from './display/screen'
import { createFormPinger } from './forms/pinger'
import { checkFormProviders } from './forms/provider-check'
import { startFrameLoop } from './frames/frames'
import { checkpointProfile, prepareProfile, restoreProfile, startCheckpoints } from './profile/profile'
import { readMasterKey } from './profile/keys'
import { joinRecording } from './recorder/join'
import { startRecorder } from './recorder/recorder'

export interface OccurrenceOutcome {
  result: 'completed' | 'denied' | 'not_admitted' | 'failed'
  endedBy: 'page' | 'removed' | 'hard_stop' | 'dropped' | 'terminated' | null
  reason: string | null
  joinedAt: string | null
  endedAt: string
}

// Every collaborator of runOccurrence. Production uses the real modules; tests pass fakes for the ones they script.
export interface RunDeps {
  prepareProfile: typeof prepareProfile
  restoreProfile: typeof restoreProfile
  readMasterKey: typeof readMasterKey
  startScreen: typeof startScreen
  launchBrowser: typeof launchBrowser
  launchGuestStage: typeof launchGuestStage
  startCheckpoints: typeof startCheckpoints
  checkpointProfile: typeof checkpointProfile
  checkFormProviders: typeof checkFormProviders
  startAudioSource: typeof startAudioSource
  startRecorder: typeof startRecorder
  joinRecording: typeof joinRecording
  adapterFor: typeof adapterFor
  startChatCapture: typeof startChatCapture
  startFrameLoop: typeof startFrameLoop
  startLiveAsr: typeof startLiveAsr
  createFormPinger: typeof createFormPinger
  sendPing: typeof sendPing
  now(): Date
  sleep(ms: number): Promise<void>
  /** Aborted by the CLI on SIGTERM or SIGINT: the run leaves the meeting and finishes its teardown. */
  signal?: AbortSignal
  /** Test seam: the time teardown has in all, in milliseconds. Default 50 000, inside the 60 s stop timeout. */
  teardownBudgetMs?: number
}

export const defaultDeps: RunDeps = {
  prepareProfile,
  restoreProfile,
  readMasterKey,
  startScreen,
  launchBrowser,
  launchGuestStage,
  startCheckpoints,
  checkpointProfile,
  checkFormProviders,
  startAudioSource,
  startRecorder,
  joinRecording,
  adapterFor,
  startChatCapture,
  startFrameLoop,
  startLiveAsr,
  createFormPinger,
  sendPing,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}
