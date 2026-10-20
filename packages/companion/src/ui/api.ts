// The whole IPC surface between the app's pages and the main process: one fixed channel per named function, and the
// shape of what crosses. Nothing generic: a page cannot name a channel, only call a function its preload exposes.
// This file has no imports, so a preload can use it without pulling a library into its bundle.

export const CHANNELS = {
  pairingDefaults: 'tm:pairing:defaults',
  pairingSubmit: 'tm:pairing:submit',
  settingsGet: 'tm:settings:get',
  settingsSave: 'tm:settings:save',
  settingsChooseFolder: 'tm:settings:choose-folder',
  signinDone: 'tm:signin:done'
} as const

export interface PairingInput {
  serverUrl: string
  code: string
}

export interface SettingsForm {
  summariesDir: string
  whisperCommand: string
  /** Empty means "no folder": the command runs where the app runs. */
  whisperCwd: string
  whisperModel: string
}

export type FolderKind = 'summaries' | 'whisper'

/** What a form action answers. The message is a fixed sentence for the member: no server text, no secret. */
export type ActionResult = { ok: true } | { ok: false; message: string }

/** The functions the preloads expose to the pages (`window.tm`). Each page gets only its own part. */
export interface PairingApi {
  /** The website address to prefill (`Settings.serverUrl`). */
  defaults(): Promise<{ serverUrl: string }>
  submit(input: PairingInput): Promise<ActionResult>
}
export interface SettingsApi {
  get(): Promise<SettingsForm>
  save(form: SettingsForm): Promise<ActionResult>
  /** Opens the folder picker. Resolves to the chosen folder, or null when the member cancelled. */
  chooseFolder(kind: FolderKind): Promise<string | null>
}
export interface SigninApi {
  done(): Promise<void>
}
