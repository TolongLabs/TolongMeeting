// Meet fixture behaviour for plan 05 task 7 (layout). Stub from the skeleton (05-F0): app.html loads this file after its
// core and renders once all task scripts are in. Add this task's dynamic behaviour here and nowhere else, through
// window.__meet (cfg, render, scene, onClick, onRender; see app.html). Here: the captions toggle, the More options menu,
// Adjust view, the share video and the People badge. Decoy controls (Raise hand, React, Present now) sit in the toolbar,
// and a second dialog with its own Close button (otherDialog) precedes the Adjust view dialog, so a test can see that the
// worker never clicks them; their clicks land in window.__forbidden, which join.js creates and owns the list of.
;(function () {
  const meet = window.__meet
  let captionsOff = false
  let menuOpen = false
  let dialogOpen = false

  function button(label, attrs = {}) {
    const node = document.createElement('button')
    node.setAttribute('aria-label', label)
    node.textContent = label
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    return node
  }

  function menu() {
    const node = document.createElement('div')
    node.setAttribute('role', 'menu')
    for (const label of ['Adjust view', 'Turn on captions', 'Settings']) {
      const item = document.createElement('div')
      item.setAttribute('role', 'menuitem')
      item.textContent = label
      node.append(item)
    }
    return node
  }

  function dialog() {
    const node = document.createElement('div')
    node.setAttribute('role', 'dialog')
    const heading = document.createElement('p')
    heading.textContent = 'Adjust view'
    node.append(heading)
    for (const label of ['Auto', 'Tiled', 'Spotlight', 'Sidebar']) {
      const option = document.createElement('div')
      option.setAttribute('role', 'radio')
      option.setAttribute('aria-checked', 'false')
      option.textContent = label
      node.append(option)
    }
    node.append(button('Close'))
    return node
  }

  // A dialog that is not Adjust view, with a Close button of its own: it comes first in the page.
  function otherDialog() {
    const node = document.createElement('div')
    node.setAttribute('role', 'dialog')
    const heading = document.createElement('p')
    heading.textContent = 'Meeting details'
    node.append(heading, button('Close', { 'data-decoy': '' }))
    return node
  }

  // A share is a video whose stream is a canvas of the configured size, so videoWidth and videoHeight are real. The holder
  // ignores the pointer so it never covers the toolbar.
  function share(box, width, height) {
    const holder = document.createElement('div')
    holder.setAttribute('data-is-presentation', 'true')
    holder.style.cssText = `position:absolute;pointer-events:none;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`
    const video = document.createElement('video')
    video.style.cssText = 'width:100%;height:100%'
    video.muted = true
    video.autoplay = true
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').fillRect(0, 0, width, height)
    video.srcObject = canvas.captureStream()
    holder.append(video)
    return holder
  }

  meet.onClick((event, label, control) => {
    // The other dialog's Close is a decoy: only the Adjust view dialog's own Close may be clicked.
    if (control.hasAttribute('data-decoy')) window.__forbidden.push(`${label} (other dialog)`)
    const inToolbar = control.closest("[role='toolbar']") !== null
    if (label === 'More options' && inToolbar) menuOpen = true
    else if (label === 'Adjust view' && menuOpen) [menuOpen, dialogOpen] = [false, true]
    else if (label === 'Close' && dialogOpen) dialogOpen = false
    else if (label === 'Turn off captions' && inToolbar) captionsOff = true
    else if (label === 'Turn on captions' && inToolbar) captionsOff = false
    else return
    meet.render()
  })

  meet.onRender((root) => {
    if (meet.cfg.scene !== 'meeting') {
      menuOpen = false
      dialogOpen = false
      return
    }
    const toolbar = root.querySelector("[role='toolbar']")
    toolbar.append(button('Raise hand'), button('React'), button('Present now'))
    if (meet.cfg.captions !== null) toolbar.append(button(captionsOff ? 'Turn on captions' : 'Turn off captions'))
    if (captionsOff) root.querySelector("[aria-label='Captions']")?.remove()
    if (meet.cfg.peopleCount !== null) {
      const people = root.querySelector("[aria-label='People']")
      const count = document.createElement('span')
      count.textContent = ` ${meet.cfg.peopleCount}`
      people.append(count)
    }
    if (meet.cfg.share) root.append(share(meet.cfg.share.box, meet.cfg.share.width, meet.cfg.share.height))
    if (menuOpen) root.append(menu())
    if (meet.cfg.otherDialog) root.append(otherDialog())
    if (dialogOpen) root.append(dialog())
  })

  meet.loaded.push('layout')
})()
