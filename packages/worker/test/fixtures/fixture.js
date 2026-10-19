// Shared by the Zoom fixtures. State lives in sessionStorage so it survives the navigations between pages
// (and is shared with the same-origin iframe), and every read goes to storage.
;(function () {
  const KEY = '__fixture'
  const read = () => JSON.parse(sessionStorage.getItem(KEY) || '{"clicks":[],"typedName":""}')
  const write = (state) => sessionStorage.setItem(KEY, JSON.stringify(state))
  window.__fixture = {
    get clicks() {
      return read().clicks
    },
    get typedName() {
      return read().typedName
    },
    click(name) {
      const state = read()
      state.clicks.push(name)
      write(state)
    },
    typeName(value) {
      const state = read()
      state.typedName = value
      write(state)
    }
  }
})()
