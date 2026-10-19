// Behaviour of the Microsoft Forms fixtures (the DOM of config/selectors/microsoft-forms.json). Loaded by every form page.
// Real Microsoft Forms were not available when these were written: they stand in for the DOM the map describes.
const QUESTION = "div[data-automation-id='questionItem']"
const TITLE = "span[data-automation-id='questionTitle']"
const ERROR = "[data-automation-id='validationError']"
const COPY = "input[type='checkbox'][aria-label*='receipt']"
const all = (root, selector) => [...root.querySelectorAll(selector)]
const questionOf = (el) => el.closest(QUESTION)
const labelOf = (question) =>
  [...question.querySelector(TITLE).childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join('')
    .trim()
const isRequired = (question) => question.querySelector("span[aria-label='Required']") !== null

// The answer in a question: a string, an array for checkboxes, or null when it is empty.
function answerOf(question) {
  const radio = all(question, "input[type='radio']")
  if (radio.length > 0) return radio.find((r) => r.checked)?.value ?? null
  const boxes = all(question, "input[type='checkbox']")
  if (boxes.length > 0) {
    const chosen = boxes.filter((box) => box.checked).map((box) => box.value)
    return chosen.length > 0 ? chosen : null
  }
  const trigger = question.querySelector("div[role='button'][aria-haspopup='listbox']")
  if (trigger) return trigger.dataset.value || null
  const input = question.querySelector('input, textarea')
  return input && input.value.trim() !== '' ? input.value : null
}

function showRequiredErrors(scope) {
  all(document, ERROR).forEach((error) => error.remove())
  const empty = all(scope, QUESTION).filter((q) => isRequired(q) && answerOf(q) === null)
  for (const question of empty) {
    const error = document.createElement('div')
    error.setAttribute('role', 'alert')
    error.dataset.automationId = 'validationError'
    error.textContent = 'This question is required.'
    question.append(error)
  }
  return empty.length > 0
}

function closeLists() {
  all(document, "div[role='listbox']").forEach((list) => (list.hidden = true))
}

function replaceForm(message) {
  document.getElementById('app').innerHTML = ''
  const heading = document.createElement('h2')
  heading.textContent = message
  document.getElementById('app').append(heading)
}

async function submit() {
  const answers = {}
  for (const question of all(document, QUESTION)) {
    const answer = answerOf(question)
    if (answer !== null) answers[labelOf(question)] = answer
  }
  const copy = document.querySelector(COPY)
  const id = new URL(location.href).searchParams.get('id')
  const reply = await fetch(`https://forms.office.com/formapi/api/fixture/responses?id=${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers, sendCopy: copy !== null && copy.checked })
  })
  const result = await reply.json()
  if (result.alreadyResponded) return replaceForm("You've already responded")
  // "stillForm" leaves the form on show, as a provider that shows the form again does.
  if (result.stillForm) return
  if (result.captcha) {
    const frame = document.createElement('iframe')
    frame.src = 'https://forms.office.com/captcha/challenge'
    frame.title = 'Captcha challenge'
    return document.body.append(frame)
  }
  replaceForm('Your response was submitted.')
}

document.addEventListener('click', (event) => {
  const target = event.target.closest("[role='option'], [aria-haspopup='listbox'], button[data-automation-id]")
  if (!target) return closeLists()
  if (target.getAttribute('aria-haspopup') === 'listbox') {
    closeLists()
    const options = questionOf(target).querySelector("div[role='listbox']")
    // "#options-delay=300" makes the popup render that many ms after the click, as a real dropdown can.
    const delay = Number(/options-delay=(\d+)/.exec(location.hash)?.[1] ?? 0)
    if (delay > 0) setTimeout(() => (options.hidden = false), delay)
    else options.hidden = false
  } else if (target.getAttribute('role') === 'option') {
    const trigger = questionOf(target).querySelector("div[role='button'][aria-haspopup='listbox']")
    trigger.textContent = target.textContent.trim()
    trigger.dataset.value = target.dataset.value
    closeLists()
  } else {
    const page = target.closest('.page')
    const name = target.dataset.automationId
    if (showRequiredErrors(page)) return
    if (name === 'nextButton') {
      page.hidden = true
      page.nextElementSibling.hidden = false
    } else if (name === 'submitButton') {
      // "#banner" answers Submit with a page-level error banner (outside every question) and sends nothing.
      if (!location.hash.includes('banner')) return submit()
      const banner = document.createElement('div')
      banner.setAttribute('role', 'alert')
      banner.dataset.automationId = 'validationError'
      banner.textContent = 'Something went wrong. Try again later.'
      document.body.prepend(banner)
    }
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeLists()
})

// "#overlay" covers the whole page, as a cookie banner or dialog can, so no button can be clicked.
if (location.hash.includes('overlay')) {
  const cover = document.createElement('div')
  cover.style.cssText = 'position:fixed;inset:0;z-index:99;background:rgba(0,0,0,.4)'
  document.body.append(cover)
  // Counts the mouse events that reach the page, so a test can show that a refused Submit sent none.
  window.mouseEvents = 0
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'])
    window.addEventListener(type, () => window.mouseEvents++, true)
}

if (location.hash === '#copy-on') {
  const copy = document.querySelector(COPY)
  if (copy) copy.checked = true
}
