'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Notice } from '../../components/Notice'
import { GENERIC_PROBLEM, getJson, putJson, Refused } from './fetch-json'

// The Google Picker lets the member choose a Drive folder. Its access token lasts an hour and is only for this: the
// server hands it to this click, it lives in this function's variables and the Picker's own memory, and it is never put
// in state, the page, storage or a URL. The page's Content-Security-Policy (`lib/connections-csp.ts`) lets scripts load
// from `apis.google.com` and frames from `docs.google.com`, and nothing else beyond the site itself.

const PICKER_SCRIPT = 'https://apis.google.com/js/api.js'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

// The few parts of Google's script that this file uses (Google ships no types).
interface PickerView {
  setSelectFolderEnabled(on: boolean): PickerView
  setMimeTypes(types: string): PickerView
}
interface PickerResponse {
  action: string
  docs?: { id: string }[]
}
interface Picker {
  setVisible(visible: boolean): void
  dispose(): void
}
interface PickerBuilder {
  setOAuthToken(token: string): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  setAppId(appId: string): PickerBuilder
  setOrigin(origin: string): PickerBuilder
  addView(view: PickerView): PickerBuilder
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder
  build(): Picker
}
interface GooglePicker {
  PickerBuilder: new () => PickerBuilder
  DocsView: new (viewId: string) => PickerView
  ViewId: { FOLDERS: string }
  Action: { PICKED: string; CANCEL: string }
}
interface GoogleWindow {
  gapi?: { load(api: string, callback: () => void): void }
  google?: { picker?: GooglePicker }
}

const googleWindow = () => window as unknown as GoogleWindow

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () =>
      reject(new Refused("Google's folder picker did not load. Check your connection and try again."))
    document.head.append(script)
  })
}

async function loadPicker(): Promise<GooglePicker> {
  if (!googleWindow().gapi) await loadScript(PICKER_SCRIPT)
  await new Promise<void>((resolve) => googleWindow().gapi!.load('picker', resolve))
  const picker = googleWindow().google?.picker
  if (!picker) throw new Refused(GENERIC_PROBLEM)
  return picker
}

/** Shows the Picker with `token` and resolves with the chosen folder's id, or `null` when the member closes it. */
function chooseFolder(
  picker: GooglePicker,
  config: { token: string; apiKey: string; appId: string }
): Promise<string | null> {
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setMimeTypes(FOLDER_MIME)
    const built: Picker = new picker.PickerBuilder()
      .setOAuthToken(config.token)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOrigin(window.location.origin)
      .addView(view)
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED) {
          built.dispose()
          resolve(response.docs?.[0]?.id ?? null)
        } else if (response.action === picker.Action.CANCEL) {
          built.dispose()
          resolve(null)
        }
      })
      .build()
    built.setVisible(true)
  })
}

function pickerConfig(body: unknown): { token: string; apiKey: string; appId: string } {
  if (typeof body === 'object' && body !== null) {
    const { accessToken, apiKey, appId } = body as Record<string, unknown>
    if (typeof accessToken === 'string' && typeof apiKey === 'string' && typeof appId === 'string')
      return { token: accessToken, apiKey, appId }
  }
  throw new Refused(GENERIC_PROBLEM)
}

/** "Pick a folder": opens the Google Picker and saves the folder the member chooses. */
export function GoogleFolderPicker() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function pick() {
    setBusy(true)
    setProblem(null)
    try {
      const config = pickerConfig(await getJson('/api/connections/google/picker'))
      const folderId = await chooseFolder(await loadPicker(), config)
      if (folderId !== null) {
        await putJson('/api/connections/google/folder', { folderId })
        router.refresh()
      }
    } catch (e) {
      if (e instanceof Refused) setProblem(e.message)
      else {
        console.error(e)
        setProblem(GENERIC_PROBLEM)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" disabled={busy} onClick={() => void pick()}>
        {busy ? 'Opening the picker...' : 'Pick a folder'}
      </button>
      {problem !== null && <Notice kind="error">{problem}</Notice>}
    </>
  )
}
