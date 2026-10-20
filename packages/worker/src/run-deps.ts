import type { ChatApp } from '@tm/core'
import { sendPing } from '@tm/notify'
import { openSigninTabs, restoreDeskAnchor } from './control/desk-tabs'
import type { HeartbeatOptions } from './control/heartbeat'
import { idleMs, startVnc } from './control/vnc'
import { adapterFor } from './adapters'
import { startLiveAsr } from './asr/live'
import { startAudioSource } from './audio/source'
import { startChatCapture } from './chat/capture'
import { launchBrowser, launchGuestStage, openDeskTab } from './chrome/launch'
import { startScreen } from './display/screen'
import { startFormDispatcher } from './forms/dispatcher'
import { resolveFormLink } from './forms/links'
import { checkFormProviders } from './forms/provider-check'
import { startFrameLoop } from './frames/frames'
import { checkpointProfile, prepareProfile, restoreProfile, startCheckpoints } from './profile/profile'
import { loadProfileKey } from './profile/key'
import { joinRecording } from './recorder/join'
import { startRecorder } from './recorder/recorder'
import { watcherFor, type StartWatcher } from './watchers'

export interface OccurrenceOutcome {
  result: 'completed' | 'denied' | 'not_admitted' | 'failed'
  endedBy: 'page' | 'removed' | 'hard_stop' | 'dropped' | 'terminated' | 'member_left' | 'stopped' | null
  reason: string | null
  /** Only on `member_left`: the command that ended the meeting. */
  command?: 'leave_now' | 'take_over'
  joinedAt: string | null
  endedAt: string
}

// Every collaborator of runOccurrence. Production uses the real modules; tests pass fakes for the ones they script.
export interface RunDeps {
  prepareProfile: typeof prepareProfile
  restoreProfile: typeof restoreProfile
  loadProfileKey: typeof loadProfileKey
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
  startFormDispatcher: typeof startFormDispatcher
  resolveFormLink: typeof resolveFormLink
  startVnc: typeof startVnc
  idleMs: typeof idleMs
  openSigninTabs: typeof openSigninTabs
  restoreDeskAnchor: typeof restoreDeskAnchor
  /** Opens a tab in the desk window; each chat watcher gets one. */
  openDeskTab: typeof openDeskTab
  /** The watcher for a chat app, or null where there is none. */
  startWatcher: (app: ChatApp) => StartWatcher | null
  sendPing: typeof sendPing
  now(): Date
  sleep(ms: number): Promise<void>
  /** Aborted by the CLI on SIGTERM or SIGINT: the run leaves the meeting and finishes its teardown. */
  signal?: AbortSignal
  /** Test seam: the time teardown has in all, in milliseconds. Default 50 000, inside the 60 s stop timeout. */
  teardownBudgetMs?: number
  /** Test seam: the heartbeat's timing (default every 5 s, 4 s timeout, backing off from 1 s to 30 s). */
  heartbeat?: Pick<HeartbeatOptions, 'intervalMs' | 'timeoutMs' | 'backoff'>
}

export const defaultDeps: RunDeps = {
  prepareProfile,
  restoreProfile,
  loadProfileKey,
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
  startFormDispatcher,
  resolveFormLink,
  startVnc,
  idleMs,
  openSigninTabs,
  restoreDeskAnchor,
  openDeskTab,
  startWatcher: watcherFor,
  sendPing,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}
