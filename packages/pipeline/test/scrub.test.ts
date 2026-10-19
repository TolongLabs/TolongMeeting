import { expect, test } from 'bun:test'
import { gateLinks, linksIn, normalizeText, scrub } from '../src/scrub'

const REMOVED = '[meeting link removed]'

test('every Teams link is removed outright, whatever its shape', () => {
  for (const url of [
    'https://teams.microsoft.com/l/meeting/abc',
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d',
    'https://teams.microsoft.com/v2/?meetingjoin=true#/meet/123?p=SECRET',
    'https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_x%40thread.v2%2F0',
    'https://TEAMS.MICROSOFT.COM/l/meetup-join/abc',
    'https://teams.live.com/meet/9876?p=abc',
    'teams.microsoft.com/l/meetup-join/19:meeting_abc'
  ])
    expect(scrub(`join ${url} now`)).toBe(`join ${REMOVED} now`)
})

test('a trailing dot on a Zoom host does not hide the link; a dot ending a sentence stays', () => {
  expect(scrub('https://us02web.zoom.us./j/123456789')).toBe(REMOVED)
  expect(scrub('https://us02web.zoom.us.:443/j/1')).toBe(REMOVED)
  expect(scrub('zoommtg://zoom.us/join?confno=123&pwd=abc')).toBe(REMOVED)
  expect(scrub('Use zoom.us.')).toBe(`Use ${REMOVED}.`)
})

test('a join link percent-encoded in a query value is removed, even encoded twice', () => {
  expect(scrub('https://example.com/redirect?url=https%3A%2F%2Fzoom.us%2Fj%2F123%3Fpwd%3Dabc')).toBe(REMOVED)
  expect(scrub('see https://example.com/r?u=https%253A%252F%252Fus02web.zoom.us%252Fj%252F1 ok')).toBe(
    `see ${REMOVED} ok`
  )
  expect(scrub('https://example.com/r?u=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij')).toBe(REMOVED)
  expect(scrub('https://example.com/r?u=https%3A%2F%2Fexample.org%2Fpage%3Fa%3D1')).toBe(
    'https://example.com/r?u=https%3A%2F%2Fexample.org%2Fpage%3Fa%3D1'
  )
})

test('spoken passcodes: digit groups up to 12, spelled-out digits up to 12 words, with or without "is", ":" or "="', () => {
  const groups = Array.from({ length: 12 }, (_, i) => i + 1).join(' ')
  expect(scrub(`passcode ${groups} then`)).toBe('passcode: [removed] then')
  expect(scrub('the Passcode is 4 8 1 5 9 2')).toBe('the Passcode: [removed]')
  expect(scrub('the passcode is one two three four five six')).toBe('the passcode: [removed]')
  expect(scrub('pass code is one two three four five six seven eight nine zero oh one, then')).toBe(
    'pass code: [removed], then'
  )
  expect(scrub('passcode: nine eight seven six')).toBe('passcode: [removed]')
  expect(scrub('passcode one two three four')).toBe('passcode: [removed]')
  expect(scrub('pwd=Ab1.2 to join')).toBe('pwd: [removed] to join')
  expect(scrub('passcode - 123456')).toBe('passcode: [removed]')
  expect(scrub('passcode—123456')).toBe('passcode: [removed]')
  expect(scrub('Meeting ID: 123 4567 8901 Passcode: 998877')).toBe('Meeting ID: [removed] Passcode: [removed]')
})

test('"password" followed by an ordinary word is left alone; with a digit, ":", "=" or "is" it is cut', () => {
  const plain = 'password hashing and salting; Password policy matters; a password manager; password-protected files'
  expect(scrub(plain)).toBe(plain)
  expect(scrub('the password is hunter2')).toBe('the password: [removed]')
  expect(scrub('password: abc')).toBe('password: [removed]')
  expect(scrub('password=abc')).toBe('password: [removed]')
  expect(scrub('password hunter2 ok')).toBe('password: [removed] ok')
})

test('scrub twice gives the same text', () => {
  for (const text of [
    'passcode 1 2 3 4 5 6 7 8 9 10 11 12 13 14',
    'zoommtg://zoom.us/join?pwd=a',
    'https://example.com/r?u=https%3A%2F%2Fzoom.us%2Fj%2F1',
    'the password is one two three'
  ])
    expect(scrub(scrub(text))).toBe(scrub(text))
})

test('gateLinks keeps only links in the allowed set, exactly', () => {
  const allowed = new Set(linksIn('Slides at https://real.example/slides, and www.real.example/x.'))
  expect(allowed).toEqual(new Set(['https://real.example/slides', 'www.real.example/x']))
  expect(
    gateLinks('a https://real.example/slides. b https://real.example/slides/extra c www.evil.example/x d', allowed)
  ).toBe('a https://real.example/slides. b [link removed] c [link removed] d')
})

// What the summary does to a model string before it keeps it.
const gate = (text: string, allowed: string[] = []): string =>
  gateLinks(scrub(normalizeText(text)), new Set(allowed.map((a) => scrub(normalizeText(a)))))

test('a bare host, in any case or script, and every odd scheme is removed from running text', () => {
  const cases = [
    'evil.com/login',
    'EVIL.COM/x',
    'evil.com:8080',
    'evil.example/a?b=1#c',
    'xn--80ak6aa92e.com/pay',
    'аррӏе.com/pay',
    'bit.ly/xyz',
    'sub.domain.evil.co.uk/x',
    'ftp://evil.example/x',
    'file:///etc/passwd',
    'mailto:a@evil.example',
    'data:text/html;base64,PHNjcmlwdD4=',
    'javascript:alert#1',
    'JAVASCRIPT:alert#1',
    'tel:+60123',
    'sms:+60123',
    'intent://scan/#Intent;scheme=zxing;end',
    'hxxps://evil.example/x',
    'hxxp://evil.example/x',
    'h**ps://evil.example/x',
    'https:evil.example',
    'htt\u200bps://evil.example/x',
    'https://evil\u200b.example/x',
    '\uff48\uff54\uff54\uff50\uff53://evil.example/x',
    'https://evil\u3002example/x',
    'evil[.]example/x'
  ]
  for (const url of cases) expect(gate(`see ${url} now`), url).toBe('see [link removed] now')
})

test('a script link loses its code', () => {
  expect(gate('x javascript:alert(document.cookie) y')).not.toContain('alert')
})

test('a bare or odd-scheme link that the sources carry exactly survives; a near miss does not', () => {
  const allowed = ['real.example/slides', 'https://real.example/deck', 'mailto:ta@real.example']
  expect(gate('a real.example/slides b', allowed)).toBe('a real.example/slides b')
  expect(gate('a https://real.example/deck. b', allowed)).toBe('a https://real.example/deck. b')
  expect(gate('a mailto:ta@real.example b', allowed)).toBe('a mailto:ta@real.example b')
  expect(gate('a real.example/slides/x b', allowed)).toBe('a [link removed] b')
  expect(gate('a REAL.EXAMPLE/slides b', allowed)).toBe('a [link removed] b')
  expect(gate('a real.example/deck b', allowed)).toBe('a [link removed] b')
  expect(gate('a http://real.example/deck b', allowed)).toBe('a [link removed] b')
})

test('versions, file names, email addresses and ordinary prose are not links', () => {
  for (const text of [
    'version 1.2.3 is out',
    'Python 3.12.1 and v2.0.0-beta',
    'read notes.pdf and slides.pptx, then lab1.ipynb',
    'open index.html, style.css and src/app.js',
    'e.g. this, i.e. that, U.S.A. 8.30pm RM1.50',
    'mail john.doe@school.edu.my about it',
    'tel: 555 and data: the results',
    'The password is the thing.'
  ]) {
    const kept = text.replace('The password is the thing.', 'The password: [removed] thing.')
    expect(gate(text), text).toBe(kept)
  }
  expect(linksIn('notes.pdf, 1.2.3, evil.com')).toEqual(['evil.com'])
})

test('a file extension that is also a TLD, or a file name with a path or port, is a link', () => {
  expect(gate('see main.py')).toBe('see [link removed]')
  expect(gate('see notes.pdf/extra')).toBe('see [link removed]')
  expect(gate('see notes.pdf:8080')).toBe('see [link removed]')
  expect(gate('see main.py', ['main.py'])).toBe('see main.py')
})

test('a join link percent-encoded inside a scheme-less link is removed', () => {
  expect(scrub('example.com/r?u=https%3A%2F%2Fzoom.us%2Fj%2F1')).toBe(REMOVED)
  expect(scrub('see www.example.com/r?u=https%253A%252F%252Fzoom.us%252Fj%252F1.')).toBe(`see ${REMOVED}.`)
  expect(scrub('(example.com/r?u=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij)')).toContain(REMOVED)
  expect(scrub('example.com/r?u=https%3A%2F%2Fexample.org%2Fa')).toBe('example.com/r?u=https%3A%2F%2Fexample.org%2Fa')
})

test('a passcode parameter with an encoded "=" is stripped from any query', () => {
  expect(scrub('https://example.com/x?pwd%3Dabc')).toBe('https://example.com/x')
  expect(scrub('https://example.com/x?a=1&passcode%3D123&b=2#top')).toBe('https://example.com/x?a=1&b=2#top')
  expect(scrub('https://example.com/x?PWD%3dabc&a=1')).toBe('https://example.com/x?a=1')
  expect(scrub('example.com/x?pwd%3Dabc')).toBe('example.com/x')
  expect(scrub('https://example.com/x?a=1')).toBe('https://example.com/x?a=1')
  expect(scrub(scrub('https://example.com/x?pwd%3Dabc'))).toBe('https://example.com/x')
})
