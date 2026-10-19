// Shared by the Zoom fixtures. State lives in sessionStorage so it survives the navigations between pages
// (and is shared with the same-origin iframe), and every read goes to storage.
;(function () {
  const KEY = '__fixture'
  // Controls the worker must never click: microphone, camera, share, reactions, the chat input, and the
  // non-allowlist buttons of the notice and breakout dialogs. Clicking one is also recorded in `forbidden`.
  const FORBIDDEN = new Set([
    'audio',
    'video',
    'share',
    'react',
    'chat input',
    'allow',
    'start video',
    'join breakout room',
    'breakout join'
  ])
  const read = () => JSON.parse(sessionStorage.getItem(KEY) || '{"clicks":[],"forbidden":[],"typedName":""}')
  const write = (state) => sessionStorage.setItem(KEY, JSON.stringify(state))
  window.__fixture = {
    get clicks() {
      return read().clicks
    },
    get forbiddenClicks() {
      return read().forbidden
    },
    get typedName() {
      return read().typedName
    },
    click(name) {
      const state = read()
      state.clicks.push(name)
      if (FORBIDDEN.has(name)) state.forbidden.push(name)
      write(state)
    },
    typeName(value) {
      const state = read()
      state.typedName = value
      write(state)
    }
  }
})()
