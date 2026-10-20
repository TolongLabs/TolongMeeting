import { describe, expect, test } from 'bun:test'
import { normaliseMeetingLink, normaliseMeetLink } from '../src'

const MEET = 'https://meet.google.com/abc-defg-hij'
const LOOKUP = 'https://meet.google.com/lookup/testclass'
const safelink = (target: string) =>
  `https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent(target)}&data=TESTDATA&reserved=0`

describe('normaliseMeetLink', () => {
  test.each([
    [MEET, MEET],
    [`  ${MEET}\n`, MEET],
    [`${MEET}/`, MEET],
    ['https://meet.google.com/ABCDEFGHIJ', MEET],
    ['https://meet.google.com/ABC-DEFG-HIJ', MEET],
    ['HTTPS://Meet.Google.Com/abc-defg-hij', MEET],
    ['meet.google.com/abc-defg-hij', MEET],
    ['MEET.google.com/abc-defg-hij', MEET],
    [`${MEET}?authuser=1&hs=122&pli=1`, MEET],
    [`${MEET}#ignored`, MEET],
    [`https://www.google.com/url?q=${encodeURIComponent(MEET)}&sa=D&source=calendar`, MEET],
    [safelink(MEET), MEET],
    [safelink(safelink(MEET)), MEET],
    [safelink(`${MEET}?authuser=1`), MEET],
    ['https://g.co/meet/abc-defg-hij', MEET],
    ['g.co/meet/abc-defg-hij', MEET],
    ['https://g.co/meet/ABCDEFGHIJ?x=1', MEET],
    [LOOKUP, LOOKUP],
    [`${LOOKUP}?authuser=2`, LOOKUP],
    ['meet.google.com/lookup/testclass', LOOKUP],
    [safelink(LOOKUP), LOOKUP]
  ])('normalises %s', (input, expected) => {
    expect(normaliseMeetLink(input)).toBe(expected)
  })

  test.each([
    'https://meet.google.com/new',
    'https://meet.google.com/landing',
    'https://meet.google.com/',
    'https://meet.google.com',
    'https://meet.google.com/abc-defg',
    'https://meet.google.com/abc-defg-hij-klm',
    'https://meet.google.com/abcd-efg-hij',
    'https://meet.google.com/ab-defg-hij',
    'https://meet.google.com/abc-def1-hij',
    'https://meet.google.com/abc_defg_hij',
    'https://meet.google.com/abc defg hij',
    'https://meet.google.com/abc-defg-hij/extra',
    'https://meet.google.com/abc-defg-hij//',
    'https://meet.google.com/abcdefghi',
    'https://meet.google.com/abcdefghijk',
    'https://meet.google.com/lookup',
    'https://meet.google.com/lookup/',
    'https://meet.google.com/lookup/a/b',
    'https://meet.google.com/lookup/has space',
    'https://meet.google.com/lookup/' + 'a'.repeat(65),
    'https://meet.google.com/Lookup/testclass',
    'https://meet.google.com/_meet/abc-defg-hij',
    'https://g.co/meet',
    'https://g.co/meet/',
    'https://g.co/meet/abc-defg',
    'https://g.co/meet/lookup/testclass',
    'https://g.co/abc-defg-hij',
    'https://g.co/meeting/abc-defg-hij',
    'https://teams.microsoft.com/meet/1234567890123?p=TESTPASS',
    'https://zoom.us/j/1234567890',
    'https://example.com/abc-defg-hij',
    'not a url',
    'abc-defg-hij',
    ''
  ])('rejects %s', (input) => {
    expect(normaliseMeetLink(input)).toBeNull()
  })

  test('look-alike hosts, other subdomains and other schemes are refused', () => {
    for (const host of [
      'meet.google.com.evil.example',
      'meet.google.com.',
      'meet.google.com.evil',
      'evilmeet.google.com',
      'evil-meet.google.com',
      'xmeet.google.com',
      'foo.meet.google.com',
      'meet.google.com.au',
      'meet.google.co',
      'meet.gogle.com',
      'meet.google.comevil.example',
      'google.com',
      'www.google.com',
      'meet-google.com',
      'meet.google.com@evil.example',
      'g.co.evil.example',
      'g.co.',
      'xg.co',
      'foo.g.co',
      'g.com',
      'meet.g.co'
    ]) {
      expect(normaliseMeetLink(`https://${host}/abc-defg-hij`), host).toBeNull()
      expect(normaliseMeetLink(`https://${host}/meet/abc-defg-hij`), host).toBeNull()
      expect(normaliseMeetLink(`https://${host}/lookup/testclass`), host).toBeNull()
    }
    expect(normaliseMeetLink(MEET.replace('https:', 'http:'))).toBeNull()
    expect(normaliseMeetLink(MEET.replace('https:', 'ftp:'))).toBeNull()
    expect(normaliseMeetLink(MEET.replace('https:', 'javascript:'))).toBeNull()
    expect(normaliseMeetLink(MEET.replace('https://', '//'))).toBeNull()
    expect(normaliseMeetLink('http://g.co/meet/abc-defg-hij')).toBeNull()
    expect(normaliseMeetLink(`evil.example/${MEET}`)).toBeNull()
  })

  test('hosts the URL parser would rewrite are refused as written', () => {
    for (const url of [
      'https://meet.google%2Ecom/abc-defg-hij',
      'https://meet%2egoogle.com/abc-defg-hij',
      'https://%6Det.google.com/abc-defg-hij',
      'https://meet.google.com%2Fabc-defg-hij',
      'https://meet.google.com%2F@evil.example/abc-defg-hij',
      'https://ｍeet.google.com/abc-defg-hij',
      'https://meet。google.com/abc-defg-hij',
      'https://meet.google.com。/abc-defg-hij',
      'https://meet.google.com／abc-defg-hij'
    ]) {
      expect(normaliseMeetLink(url), url).toBeNull()
    }
  })

  test('userinfo and ports are refused', () => {
    expect(normaliseMeetLink(MEET.replace('https://', 'https://user:pass@'))).toBeNull()
    expect(normaliseMeetLink(MEET.replace('https://', 'https://user@'))).toBeNull()
    expect(normaliseMeetLink(MEET.replace('https://', 'https://:pass@'))).toBeNull()
    expect(normaliseMeetLink(MEET.replace('.com/', '.com:8443/'))).toBeNull()
    expect(normaliseMeetLink(MEET.replace('.com/', '.com:443/'))).toBeNull()
    expect(normaliseMeetLink(MEET.replace('.com/', '.com:/'))).toBeNull()
    expect(normaliseMeetLink('https://g.co:8443/meet/abc-defg-hij')).toBeNull()
    expect(normaliseMeetLink('https://user@g.co/meet/abc-defg-hij')).toBeNull()
    expect(normaliseMeetLink('meet.google.com:8443/abc-defg-hij')).toBeNull()
  })

  test('encoded slashes, escapes, backslashes and dot segments are refused, not decoded', () => {
    for (const url of [
      'https://meet.google.com/abc-defg-hij%2F',
      'https://meet.google.com/abc%2Fdefg-hij',
      'https://meet.google.com/%2Fabc-defg-hij',
      'https://meet.google.com%2Fabc-defg-hij',
      'https://meet.google.com/abc%2Ddefg-hij',
      'https://meet.google.com/%61bc-defg-hij',
      'https://meet.google.com/abc-defg-hi%6A',
      'https://meet.google.com/lookup%2Ftestclass',
      'https://meet.google.com/lookup/test%2Fclass',
      'https://meet.google.com/lookup/test%2e%2e',
      'https://meet.google.com/abc-defg-hij%',
      'https://meet.google.com/abc-defg-hij%2',
      'https://meet.google.com\\abc-defg-hij',
      'https://meet.google.com/abc-defg-hij\\',
      'https://meet.google.com/lookup\\testclass',
      'https://g.co/meet%2Fabc-defg-hij',
      'https://g.co/meet/abc-defg-hij%2F',
      'https://meet.google.com/./abc-defg-hij',
      'https://meet.google.com/x/../abc-defg-hij',
      'https://meet.google.com/%2e/abc-defg-hij',
      'https://meet.google.com/lookup/../abc-defg-hij',
      'https://meet.google.com/lookup/./testclass',
      'https://g.co/x/../meet/abc-defg-hij'
    ]) {
      expect(normaliseMeetLink(url), url).toBeNull()
    }
  })

  test('control characters are refused, since the URL parser would strip them', () => {
    expect(normaliseMeetLink('https://meet.google.com/abc-def\tg-hij')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/abc-defg-hij\n/extra')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/abc-defg\r-hij')).toBeNull()
    expect(normaliseMeetLink('https://meet.goo\ngle.com/abc-defg-hij')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/abc-defg-hij?x=a\u0000b')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/abc-defg-hij\u007f')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/abc-defg-hij\u0085')).toBeNull()
    expect(normaliseMeetLink('https://g.co/meet/abc-defg\t-hij')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/lookup/test\tclass')).toBeNull()
    expect(normaliseMeetLink('meet.google.com/abc-defg\n-hij')).toBeNull()
    // An escaped control character is refused too, by the path rule.
    expect(normaliseMeetLink('https://meet.google.com/abc-defg-hij%00')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/abc-defg%09-hij')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/abc-defg%0A-hij')).toBeNull()
  })

  // A wrapper's parameter is percent-decoded by `unwrapLink`; a control character that appears only then must still be
  // refused, because the URL parser would strip it and turn a bad link good.
  test.each(['%09', '%0A', '%0D', '%00', '%7F'])('a wrapped target holding %s is refused', (escape) => {
    const control = decodeURIComponent(escape)
    for (const target of [
      `https://meet.google.com/abc-defg${control}-hij`,
      `https://meet.google.com/abc-defg-hij${control}`,
      `https://meet.google.com/lookup/test${control}class`,
      `https://meet.goo${control}gle.com/abc-defg-hij`,
      `https://g.co/meet/abc-defg${control}-hij`
    ]) {
      expect(safelink(target)).toContain('%')
      expect(normaliseMeetLink(safelink(target)), JSON.stringify(target)).toBeNull()
      expect(normaliseMeetLink(`https://www.google.com/url?q=${encodeURIComponent(target)}`)).toBeNull()
      expect(normaliseMeetLink(safelink(safelink(target)))).toBeNull()
    }
  })

  test('a wrapped target with spaces around it is refused', () => {
    expect(normaliseMeetLink(safelink(` ${MEET}`))).toBeNull()
    expect(normaliseMeetLink(safelink(`${MEET} `))).toBeNull()
  })

  test('a wrapper cannot smuggle in another host', () => {
    expect(normaliseMeetLink(safelink('https://evil.example/abc-defg-hij'))).toBeNull()
    expect(normaliseMeetLink(safelink('https://meet.google.com.evil.example/abc-defg-hij'))).toBeNull()
    expect(normaliseMeetLink(safelink('https://user@meet.google.com/abc-defg-hij'))).toBeNull()
    expect(normaliseMeetLink(safelink('https://meet.google.com:8443/abc-defg-hij'))).toBeNull()
    expect(normaliseMeetLink(safelink('http://meet.google.com/abc-defg-hij'))).toBeNull()
    expect(normaliseMeetLink(safelink('//evil.example/abc-defg-hij'))).toBeNull()
    expect(normaliseMeetLink(`https://www.google.com/url?q=${encodeURIComponent('https://evil.example/x')}`)).toBeNull()
    // The wrapper's own host must be one `unwrapLink` knows: any other host is not a Meet host.
    expect(normaliseMeetLink(`https://evil.example/url?q=${encodeURIComponent(MEET)}`)).toBeNull()
    expect(
      normaliseMeetLink(`https://safelinks.protection.outlook.com.evil.example/?url=${encodeURIComponent(MEET)}`)
    ).toBeNull()
  })

  test('encoded nested links are only peeled by the known wrappers, and no deeper than three', () => {
    const twice = encodeURIComponent(encodeURIComponent(MEET))
    expect(normaliseMeetLink(`https://apc01.safelinks.protection.outlook.com/?url=${twice}`)).toBeNull()
    expect(normaliseMeetLink(`https://www.google.com/url?q=${twice}`)).toBeNull()
    expect(normaliseMeetLink(safelink(safelink(safelink(safelink(MEET)))))).toBeNull()
  })

  test('Meet codes inside the query of another Meet link do not count', () => {
    expect(normaliseMeetLink('https://meet.google.com/landing?code=abc-defg-hij')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/?q=abc-defg-hij')).toBeNull()
    expect(normaliseMeetLink('https://meet.google.com/#abc-defg-hij')).toBeNull()
  })
})

describe('normaliseMeetingLink', () => {
  test('dispatches Zoom, Teams and Meet links to their own rule', () => {
    expect(normaliseMeetingLink('https://us06web.zoom.us/j/00000000000?pwd=PWD')).toBe(
      'https://us06web.zoom.us/wc/join/00000000000?pwd=PWD'
    )
    expect(normaliseMeetingLink('https://teams.microsoft.com/meet/1234567890123?p=TESTPASS')).toBe(
      'https://teams.microsoft.com/meet/1234567890123?p=TESTPASS'
    )
    expect(normaliseMeetingLink(`${MEET}?authuser=1`)).toBe(MEET)
    expect(normaliseMeetingLink(safelink(MEET))).toBe(MEET)
    expect(normaliseMeetingLink('https://g.co/meet/abc-defg-hij')).toBe(MEET)
  })

  test('chats, lookalikes and junk are null', () => {
    for (const input of [
      'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
      'https://meet.google.com.evil.example/abc-defg-hij',
      'https://meet.google.com/new',
      'not a url',
      ''
    ]) {
      expect(normaliseMeetingLink(input)).toBeNull()
    }
  })
})
