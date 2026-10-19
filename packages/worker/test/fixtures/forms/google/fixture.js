// Behaviour of the Google Forms fixtures (the DOM of config/selectors/google-forms.json). Loaded by every form page.
const COPY = "div[role='checkbox'][aria-label^='Send me a copy']"
const all = (root, selector) => [...root.querySelectorAll(selector)]
const questionOf = (el) => el.closest("div[role='listitem']")
const labelOf = (question) =>
  [...question.querySelector("div[role='heading']").childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join('')
    .trim()
const isRequired = (question) => question.querySelector("span[aria-label='Required question']") !== null
const ticked = (el) => el.getAttribute('aria-checked') === 'true'

// The answer in a question: a string, an array for checkboxes, or null when it is empty.
function answerOf(question) {
  const radio = all(question, "div[role='radio']")
  if (radio.length > 0) return radio.find(ticked)?.dataset.value ?? null
  const boxes = all(question, "div[role='checkbox']")
  if (boxes.length > 0) {
    const chosen = boxes.filter(ticked).map((box) => box.dataset.value)
    return chosen.length > 0 ? chosen : null
  }
  const listbox = question.querySelector("div[role='listbox']")
  if (listbox) return listbox.dataset.value || null
  const input = question.querySelector('input, textarea')
  return input && input.value.trim() !== '' ? input.value : null
}

function showRequiredErrors(scope) {
  all(document, "div[role='alert']").forEach((alert) => alert.remove())
  const empty = all(scope, "div[role='listitem']").filter((q) => isRequired(q) && answerOf(q) === null)
  for (const question of empty) {
    const alert = document.createElement('div')
    alert.setAttribute('role', 'alert')
    alert.textContent = 'This is a required question.'
    question.append(alert)
  }
  return empty.length > 0
}

function closeLists() {
  all(document, '.options').forEach((list) => (list.hidden = true))
}

function submit() {
  const answers = {}
  for (const question of all(document, "div[role='listitem']")) {
    const answer = answerOf(question)
    if (answer !== null) answers[labelOf(question)] = answer
  }
  const copy = document.querySelector(COPY)
  const body = { answers, sendCopy: copy !== null && ticked(copy) }
  const form = document.createElement('form')
  form.method = 'post'
  form.action = 'formResponse'
  const field = document.createElement('input')
  field.type = 'hidden'
  field.name = 'answers'
  field.value = JSON.stringify(body)
  form.append(field)
  document.body.append(form)
  form.submit()
}

document.addEventListener('click', (event) => {
  const target = event.target.closest(
    "[role='radio'], [role='checkbox'], [role='option'], [role='listbox'], [role='button']"
  )
  if (!target) return closeLists()
  const role = target.getAttribute('role')
  if (role === 'radio') {
    all(questionOf(target), "div[role='radio']").forEach((radio) => radio.setAttribute('aria-checked', 'false'))
    target.setAttribute('aria-checked', 'true')
  } else if (role === 'checkbox') {
    target.setAttribute('aria-checked', String(!ticked(target)))
  } else if (role === 'listbox') {
    closeLists()
    questionOf(target).querySelector('.options').hidden = false
  } else if (role === 'option') {
    const listbox = questionOf(target).querySelector("div[role='listbox']")
    listbox.textContent = target.textContent.trim()
    listbox.dataset.value = target.dataset.value
    closeLists()
  } else if (role === 'button') {
    const page = target.closest('.page')
    const name = target.textContent.trim()
    if (showRequiredErrors(page)) return
    if (name === 'Next') {
      page.hidden = true
      page.nextElementSibling.hidden = false
    } else if (name === 'Submit') submit()
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeLists()
})

if (location.hash === '#copy-on') document.querySelector(COPY)?.setAttribute('aria-checked', 'true')
