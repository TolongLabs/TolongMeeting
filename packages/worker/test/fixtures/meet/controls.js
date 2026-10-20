// Meet fixture behaviour for plan 05 task 5 (controls). Stub from the skeleton (05-F0): app.html loads this file after its
// core and renders once all task scripts are in. Add this task's dynamic behaviour here and nowhere else, through
// window.__meet (cfg, render, scene, onClick, onRender; see app.html). Here: the host's leave dialog. Notices, the
// side panel's Close button and the audio elements are static markup in app.html.
;(function () {
  const meet = window.__meet
  let asking = false
  // A host's Leave opens a dialog; "Just leave the call" leaves, "End the call for everyone" ends the call.
  meet.onClick((event, label) => {
    if (label === 'Leave call' && meet.cfg.host && meet.cfg.scene === 'meeting') asking = true
    else if (asking && label === 'Just leave the call') [asking, meet.cfg.scene] = [false, 'left']
    else if (asking && label === 'End the call for everyone') [asking, meet.cfg.scene] = [false, 'ended']
    else return
    meet.render()
  })
  meet.onRender((root) => {
    if (!asking || meet.cfg.scene !== 'meeting') return
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    for (const text of ['Leave the call?', 'End the call for everyone', 'Just leave the call']) {
      const node = document.createElement(text === 'Leave the call?' ? 'p' : 'button')
      node.textContent = text
      dialog.append(node)
    }
    root.append(dialog)
  })
  meet.loaded.push('controls')
})()
