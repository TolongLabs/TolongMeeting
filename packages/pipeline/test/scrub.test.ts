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
    'evil.com/a?b=1#c',
    'xn--80ak6aa92e.com/pay',
    'аррӏе.com/pay',
    'evil.рф/x',
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
    'htt​ps://evil.example/x',
    'https://evil​.example/x',
    'ｈｔｔｐｓ://evil.example/x',
    'https://evil。example/x',
    'evil[.]com/x',
    'https://user:pass@evil.example/x',
    '//evil.com/x',
    'www.evil.example/x'
  ]
  for (const url of cases) expect(gate(`see ${url} now`), url).toBe('see [link removed] now')
})

// Every shape a reviewer found that slipped past a hand-written pattern: linkify-it alone does not start a link after
// punctuation or end one before a port, a hyphen or a second dot, where a phone's linkifier still finds the host.
test('a host hidden behind or before punctuation is removed, so no bare host reaches a phone linkifier', () => {
  const cases: [string, string][] = [
    ['see .evil.com/login', 'see .[link removed]'],
    ['see -evil.com/login', 'see -[link removed]'],
    ['see @evil.com/login', 'see @[link removed]'],
    ['wait...evil.com/login', 'wait...[link removed]'],
    ['Go to…evil.com/login', 'Go to...[link removed]'],
    ['a_b.evil.com/login', 'a_[link removed]'],
    ['x@evil.com/login', '[link removed]'],
    ['user:pass@evil.com/x', 'user:[link removed]'],
    ['—evil.com/login', '—[link removed]'],
    ['evil.com:8080', '[link removed]'],
    ['evil.com-x', '[link removed]-x'],
    ['evil.com.pdf', '[link removed].pdf'],
    ['evil.com.x', '[link removed].x']
  ]
  for (const [text, expected] of cases) expect(gate(text), text).toBe(expected)
})

test('an IP address, with or without a port or path, is removed', () => {
  expect(gate('see 1.2.3.4/login now')).toBe('see [link removed] now')
  expect(gate('see 192.168.1.1 now')).toBe('see [link removed] now')
  expect(gate('see 10.0.0.1:8080/x now')).toBe('see [link removed] now')
  expect(gate('see http://127.0.0.1:3000/x now')).toBe('see [link removed] now')
  expect(gate('see v1.2.3.4')).toBe('see v[link removed]')
})

test('an app scheme is removed, with or without //', () => {
  for (const url of [
    'whatsapp://send?text=hi',
    'tg://resolve?domain=evil',
    'market://details?id=evil.app',
    'geo:3.14,101.68',
    'magnet:?xt=urn:btih:abc',
    'skype:evil?call',
    'callto:evil',
    'view-source:https://evil.example',
    'content://evil/x',
    'ws://evil.example/x',
    'steam://run/1'
  ])
    expect(gate(`see ${url} now`), url).toBe('see [link removed] now')
})

test('a plain email address is a link, and is removed', () => {
  expect(gate('mail john.doe@school.edu.my about it')).toBe('mail [link removed] about it')
  expect(gate('mail ta@real.edu about it', ['ta@real.edu'])).toBe('mail ta@real.edu about it')
})

test('a link the sources carry exactly survives; a near miss, or a link glued to another, does not', () => {
  const allowed = ['real.edu/slides', 'https://real.example/deck', 'mailto:ta@real.edu', 'www.real.example/x']
  expect(gate('a real.edu/slides b', allowed)).toBe('a real.edu/slides b')
  expect(gate('a https://real.example/deck. b', allowed)).toBe('a https://real.example/deck. b')
  expect(gate('a mailto:ta@real.edu b', allowed)).toBe('a mailto:ta@real.edu b')
  expect(gate('a (www.real.example/x) b', allowed)).toBe('a (www.real.example/x) b')
  expect(gate('a real.edu/slides/x b', allowed)).toBe('a [link removed] b')
  expect(gate('a REAL.EDU/slides b', allowed)).toBe('a [link removed] b')
  expect(gate('a real.edu/deck b', allowed)).toBe('a [link removed] b')
  expect(gate('a http://real.example/deck b', allowed)).toBe('a [link removed] b')
  expect(gate('a real.edu/slides,evil.com b', allowed)).toBe('a [link removed] b')
  expect(gate('a real.edu/slides.evil.com b', allowed)).toBe('a [link removed] b')
  expect(gate('a x@real.edu/slides b', allowed)).toBe('a [link removed] b')
})

test('versions, file names, code identifiers and ordinary prose are not links', () => {
  for (const text of [
    'version 1.2.3 is out',
    'Python 3.12.1 and v2.0.0-beta',
    'read notes.pdf and slides.pptx, then lab1.ipynb',
    'open index.html, style.css and src/app.js',
    'e.g. this, i.e. that, U.S.A. 8.30pm RM1.50',
    'call np.mean(x), df.head(), os.path.join, torch.nn.Linear, self.model and math.sqrt',
    'tel: 555 and data: the results',
    'The password is the thing.'
  ]) {
    const kept = text.replace('The password is the thing.', 'The password: [removed] thing.')
    expect(gate(text), text).toBe(kept)
  }
  expect(linksIn('notes.pdf, 1.2.3, np.mean, evil.com')).toEqual(['evil.com'])
})

test('a file extension that is also a TLD is a link; one that is not a TLD stays a file name', () => {
  expect(gate('see main.py')).toBe('see [link removed]')
  expect(gate('see main.py', ['main.py'])).toBe('see main.py')
  expect(gate('see notes.pdf/extra')).toBe('see notes.pdf/extra')
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

test('a 200 KB input of 2,000-char dotted tokens is scrubbed and gated in under 2 s', () => {
  const text = Array.from({ length: 100 }, () => 'a.'.repeat(1000)).join(' ')
  expect(text.length).toBeGreaterThan(200_000)
  let started = performance.now()
  scrub(text)
  expect(performance.now() - started).toBeLessThan(2000)
  started = performance.now()
  const gated = gate(text)
  expect(performance.now() - started).toBeLessThan(2000)
  expect(gated).toBe(Array.from({ length: 100 }, () => '[link removed]').join(' '))
})

test('a 200k run of "a" is scrubbed and gated in under 2 s, and is kept', () => {
  const run = 'a'.repeat(200_000)
  const started = performance.now()
  expect(gate(run)).toBe(run)
  expect(performance.now() - started).toBeLessThan(2000)
})

test('a word over 256 characters is one removed candidate with a dot, colon or slash, and kept without', () => {
  expect(gate(`see ${'a'.repeat(300)} now`)).toBe(`see ${'a'.repeat(300)} now`)
  expect(gate(`see ${'a.'.repeat(150)} now`)).toBe('see [link removed] now')
  expect(gate(`see ${'a'.repeat(300)}/x now`)).toBe('see [link removed] now')
})

test('a host label over 63 characters does not hide a link', () => {
  expect(gate(`see ${'a'.repeat(63)}.com/x now`)).toBe('see [link removed] now')
  expect(gate(`see ${'a'.repeat(64)}.com/x now`)).toBe('see [link removed] now')
  expect(gate(`see x.${'a'.repeat(70)}.com now`)).toBe('see x.[link removed] now')
})

test('the Teams and Meeting schemes added to the lists are removed', () => {
  expect(scrub('join msteams:/l/meetup-join/19%3ameeting_x/0 now')).toBe(`join ${REMOVED} now`)
  expect(scrub('join ms-teams:/l/meetup-join/19 now')).toBe(`join ${REMOVED} now`)
  for (const url of [
    'facetime:+60123',
    'facetime-audio:+60123',
    'sip:a@evil.example',
    'xmpp:a@evil.example',
    'bitcoin:1abc',
    'smsto:+60123',
    'mms:+60123',
    'upi://pay?pa=a@evil',
    'maps:0,0',
    'news:evil'
  ])
    expect(gate(`see ${url} now`), url).toBe('see [link removed] now')
})

test('every Meet link is removed outright: meet.google.com, g.co/meet and tel.meet', () => {
  for (const url of [
    'https://meet.google.com/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij?authuser=1&hs=122',
    'https://meet.google.com/lookup/testclass',
    'https://MEET.GOOGLE.COM/ABC-DEFG-HIJ',
    'meet.google.com/abc-defg-hij',
    'https://meet.google.com./abc-defg-hij',
    'https://meet.google.com:443/abc-defg-hij',
    'https://g.co/meet/abc-defg-hij',
    'g.co/meet/abc-defg-hij',
    'https://g.co/meet/abc-defg-hij?x=1',
    'https://tel.meet/abc-defg-hij?pin=1234567890123'
  ])
    expect(scrub(`join ${url} now`), url).toBe(`join ${REMOVED} now`)
  expect(scrub('Use meet.google.com.')).toBe(`Use ${REMOVED}.`)
})

test('a Meet link percent-encoded in another link is removed, including g.co/meet', () => {
  expect(scrub('https://example.com/r?u=https%3A%2F%2Fg.co%2Fmeet%2Fabc-defg-hij')).toBe(REMOVED)
  expect(scrub('see https://example.com/r?u=https%253A%252F%252Fmeet.google.com%252Flookup%252Fx ok')).toBe(
    `see ${REMOVED} ok`
  )
  expect(scrub('https://www.google.com/url?q=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij&sa=D')).toBe(REMOVED)
})

test('names that only look like Meet hosts are not treated as Meet links', () => {
  for (const text of ['see g.com/meet/x', 'see mymeet.google.com.au/x', 'see eg.co/meeting', 'see g.co/meetings/x'])
    expect(scrub(text), text).not.toContain(REMOVED)
})

test('a Meet code after a word that names it is cut; a hyphenated phrase on its own stays', () => {
  expect(scrub('Meeting code: abc-defg-hij')).toBe('Meeting code: [removed]')
  expect(scrub('the meet code is abc-defg-hij, see you')).toBe('the meet code: [removed], see you')
  expect(scrub('Google Meet code abc defg hij.')).toBe('Google Meet code: [removed].')
  expect(scrub('Video call ID = ABC-DEFG-HIJ')).toBe('Video call ID: [removed]')
  expect(scrub('join code is abc-defg-hij')).toBe('join code: [removed]')
  expect(scrub('Meeting ID: 123 4567 8901')).toBe('Meeting ID: [removed]')
  expect(scrub('a one-time-pad and an end-user-bug')).toBe('a one-time-pad and an end-user-bug')
  expect(scrub('the meeting code is explained in week two')).toBe('the meeting code is explained in week two')
  expect(scrub(scrub('Meeting code: abc-defg-hij'))).toBe('Meeting code: [removed]')
})

test('a passcode named with a phrase, a code word, a PIN, spaced digits or a spoken link is cut', () => {
  for (const [said, gone] of [
    ['the password for the call is 481592', /481592/],
    ['the passcode for today is Xk9pQ2', /Xk9pQ2/],
    ['use code 481592', /481592/],
    ['the join code is Xk9pQ2', /Xk9pQ2/],
    ['dial in, PIN 123 456 789#', /123|789/],
    ['the meeting needs 4 8 1 5 9 2', /4 8 1|5 9 2/],
    ['join at zoom dot us slash j slash 81234567890', /zoom dot|81234567890/],
    ['join at evil dot com slash login', /evil dot|login/]
  ] as const) {
    const out = scrub(`Ben: ${said}. Next topic`)
    expect(out, said).not.toMatch(gone)
    expect(out, said).toMatch(/^Ben: .*\[(?:meeting link )?removed\].*Next topic$/)
    expect(scrub(out), said).toBe(out)
  }
  for (const kept of [
    'use code review to catch that',
    'pin the post',
    'the dot product of a and b',
    'at 10 30 and 11 45'
  ])
    expect(scrub(kept)).toBe(kept)
})

test('a spoken-link and spaced-digit scrub is fast on long text', () => {
  const text = `${'zoom dot us slash j '.repeat(5_000)} ${'1 2 3 4 5 6 7 8 9 '.repeat(5_000)} ${'word '.repeat(50_000)}`
  const t0 = performance.now()
  scrub(text)
  expect(performance.now() - t0).toBeLessThan(3_000)
})
