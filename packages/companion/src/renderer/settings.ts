import type { FolderKind, SettingsApi } from '../ui/api'

const { settings } = (window as unknown as { tm: { settings: SettingsApi } }).tm
const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`the page has no #${id}`)
  return el as T
}

const form = byId<HTMLFormElement>('settings-form')
const summariesDir = byId<HTMLInputElement>('summaries-dir')
const whisperCommand = byId<HTMLInputElement>('whisper-command')
const whisperCwd = byId<HTMLInputElement>('whisper-cwd')
const whisperModel = byId<HTMLInputElement>('whisper-model')
const save = byId<HTMLButtonElement>('save')
const message = byId('message')

byId('close').addEventListener('click', () => window.close())

function browse(kind: FolderKind, input: HTMLInputElement): void {
  void settings.chooseFolder(kind).then((folder) => {
    if (folder !== null) input.value = folder
    input.focus()
  })
}
byId('browse-summaries').addEventListener('click', () => browse('summaries', summariesDir))
byId('browse-whisper').addEventListener('click', () => browse('whisper', whisperCwd))

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  save.disabled = true
  message.textContent = ''
  try {
    const result = await settings.save({
      summariesDir: summariesDir.value,
      whisperCommand: whisperCommand.value,
      whisperCwd: whisperCwd.value,
      whisperModel: whisperModel.value
    })
    message.textContent = result.ok ? 'Saved.' : result.message
  } catch {
    message.textContent = 'Something went wrong. Close this window and open it again.'
  } finally {
    save.disabled = false
  }
})

void settings.get().then((s) => {
  summariesDir.value = s.summariesDir
  whisperCommand.value = s.whisperCommand
  whisperCwd.value = s.whisperCwd
  whisperModel.value = s.whisperModel
  summariesDir.focus()
})
