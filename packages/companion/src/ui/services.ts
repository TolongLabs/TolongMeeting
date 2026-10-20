import { CompanionApiError, InvalidResponseError, serverOrigin } from '../api'
import { completePairing, PairingInputError, PairingRefusedError } from '../pairing'
import { EncryptionUnavailableError, type SecretStore } from '../secrets'
import { SettingsSchema, type Settings } from '../settings'
import type { StateStore } from '../state'
import type { ActionResult, SettingsForm } from './api'
import { PairingInputSchema, SettingsFormSchema } from './ipc'

// What the pairing and settings windows do. The windows hand over untrusted input (anything a page can send); every
// answer is a fixed sentence. The technical cause of a failure goes to `onError` (the log), never to the page.

const BAD_FORM = 'The form is not valid. Close the window and open it again.'
const UNREACHABLE = 'Could not pair. Check the website address and your connection, then try again.'

export interface PairingServiceDeps {
  /** The live settings: the website address to prefill. */
  settings: Pick<Settings, 'serverUrl'>
  secrets: SecretStore
  state: StateStore
  /** The device name the website lists, for example the PC's host name. */
  deviceName(): string
  saveServerUrl(url: string): Promise<void>
  /** Called once pairing worked and the tokens are stored: the app starts its loops here. */
  onPaired(): Promise<void>
  onError(error: unknown): void
  fetch?: typeof fetch
}

export class PairingService {
  private busy = false

  constructor(private readonly d: PairingServiceDeps) {}

  defaults(): { serverUrl: string } {
    return { serverUrl: this.d.settings.serverUrl }
  }

  async submit(raw: unknown): Promise<ActionResult> {
    const input = PairingInputSchema.safeParse(raw)
    if (!input.success) return { ok: false, message: BAD_FORM }
    if (this.busy) return { ok: false, message: 'Pairing is already in progress.' }
    this.busy = true
    try {
      if ((await this.d.secrets.get('deviceToken')) !== null)
        return { ok: false, message: 'This PC is already paired.' }
      let origin: string
      try {
        origin = serverOrigin(input.data.serverUrl.trim())
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : BAD_FORM }
      }
      try {
        await completePairing({
          serverUrl: origin,
          code: input.data.code.trim(),
          deviceName: this.d.deviceName(),
          secrets: this.d.secrets,
          state: this.d.state,
          saveServerUrl: this.d.saveServerUrl,
          fetch: this.d.fetch
        })
      } catch (e) {
        return { ok: false, message: this.explain(e) }
      }
      await this.d.onPaired()
      return { ok: true }
    } finally {
      this.busy = false
    }
  }

  /** Only the app's own fixed sentences reach the page. Anything else is logged and shown as a generic line. */
  private explain(e: unknown): string {
    if (
      e instanceof PairingRefusedError ||
      e instanceof PairingInputError ||
      e instanceof CompanionApiError ||
      e instanceof InvalidResponseError ||
      e instanceof EncryptionUnavailableError
    ) {
      return e.message
    }
    this.d.onError(e)
    return UNREACHABLE
  }
}

const FIELD_LABELS: Record<string, string> = {
  summariesDir: 'Summaries folder',
  'whisper.command': 'Whisper command',
  'whisper.cwd': 'Whisper folder',
  'whisper.model': 'Whisper model'
}

export interface SettingsServiceDeps {
  /** The live settings. A successful save changes this object in place, so every loop sees the new values. */
  settings: Settings
  save(next: Settings): Promise<void>
}

export class SettingsService {
  constructor(private readonly d: SettingsServiceDeps) {}

  get(): SettingsForm {
    const { summariesDir, whisper } = this.d.settings
    return {
      summariesDir,
      whisperCommand: whisper.command,
      whisperCwd: whisper.cwd ?? '',
      whisperModel: whisper.model
    }
  }

  async save(raw: unknown): Promise<ActionResult> {
    const form = SettingsFormSchema.safeParse(raw)
    if (!form.success) return { ok: false, message: BAD_FORM }
    const f = form.data
    const cwd = f.whisperCwd.trim()
    const next = SettingsSchema.safeParse({
      serverUrl: this.d.settings.serverUrl,
      summariesDir: f.summariesDir.trim(),
      whisper: { command: f.whisperCommand.trim(), cwd: cwd === '' ? null : cwd, model: f.whisperModel.trim() }
    })
    if (!next.success) {
      const issue = next.error.issues[0]!
      const label = FIELD_LABELS[issue.path.join('.')] ?? 'The form'
      const why =
        issue.code === 'too_small'
          ? 'enter a value'
          : issue.code === 'too_big'
            ? 'too long'
            : issue.code === 'custom'
              ? issue.message
              : 'not valid'
      return { ok: false, message: `${label}: ${why}` }
    }
    await this.d.save(next.data)
    Object.assign(this.d.settings, next.data)
    return { ok: true }
  }
}
