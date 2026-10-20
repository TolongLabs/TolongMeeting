import type { PairingApi } from '../ui/api'

const { pairing } = (window as unknown as { tm: { pairing: PairingApi } }).tm
const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`the page has no #${id}`)
  return el as T
}

const form = byId<HTMLFormElement>('pairing-form')
const serverUrl = byId<HTMLInputElement>('server-url')
const code = byId<HTMLInputElement>('code')
const pair = byId<HTMLButtonElement>('pair')
const close = byId<HTMLButtonElement>('close')
const message = byId('message')

close.addEventListener('click', () => window.close())

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  pair.disabled = true
  message.textContent = 'Pairing...'
  try {
    const result = await pairing.submit({ serverUrl: serverUrl.value, code: code.value })
    if (result.ok) {
      message.textContent = 'This PC is paired. You can close this window.'
      serverUrl.disabled = code.disabled = true
      close.textContent = 'Close'
      close.focus()
      return
    }
    message.textContent = result.message
    pair.disabled = false
    code.focus()
  } catch {
    message.textContent = 'Something went wrong. Close this window and open it again.'
    pair.disabled = false
  }
})

void pairing.defaults().then((d) => {
  serverUrl.value = d.serverUrl
  code.focus()
})
