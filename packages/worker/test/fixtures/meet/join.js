// Meet fixture behaviour for plan 05 task 3 (join). app.html loads this file after its core and renders once all task
// scripts are in. The pre-join flow itself is declarative in app.html (data-goto on the join buttons); this file only
// adds the forbidden-clicks log: window.__forbidden holds every click on a control the join must never touch.
;(function () {
  const FORBIDDEN = ['Present', 'Use Companion mode', 'Switch here', 'Use microphone and camera']
  window.__forbidden = []
  window.__meet.onClick((event, label) => {
    if (FORBIDDEN.includes(label)) window.__forbidden.push(label)
  })
  window.__meet.loaded.push('join')
})()
