// Meet fixture behaviour for plan 05 task 6 (chat). app.html loads this file after its core and renders once all task
// scripts are in. The scrollable chat list (chatScroll), the People panel (people) and the side-panel switching are in
// app.html; this adds the two ways a test changes the call while it runs, through window.__meet (see app.html):
//   __addMessage(m)  a message { id, sender, time, text, href? } enters the history, shown or not (as in Meet), and
//                    the list keeps its scroll position
//   __addPerson(p)   a participant { name, label? } joins the People panel
;(function () {
  const meet = window.__meet
  window.__addMessage = (message) => {
    meet.cfg.messages = [...meet.cfg.messages, message]
    meet.render()
  }
  window.__addPerson = (person) => {
    meet.cfg.people = [...meet.cfg.people, person]
    meet.render()
  }
  meet.loaded.push('chat')
})()
