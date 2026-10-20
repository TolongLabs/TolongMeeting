import { describe, expect, test } from 'bun:test'
import { normaliseMeetingLink, normaliseTeamsChatUrl, normaliseTeamsLink } from '../src'

const THREAD = '19%3Ameeting_TESTTHREAD%40thread.v2'
const CONTEXT = '%7B%22Tid%22%3A%22TENANT%22%2C%22Oid%22%3A%22ORGANISER%22%7D'
const JOIN = `https://teams.microsoft.com/l/meetup-join/${THREAD}/0?context=${CONTEXT}`
const lower = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_TESTTHREAD%40thread.v2/0?context=%7b%22Tid%22%3a%22TENANT%22%2c%22Oid%22%3a%22ORGANISER%22%7d`
const hashPath = `/l/meetup-join/${THREAD}/0?context=${CONTEXT}`
const safelink = (target: string) =>
  `https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent(target)}&data=TESTDATA&reserved=0`
const MEET = 'https://teams.microsoft.com/meet/1234567890123?p=TESTPASS'
const CHAT = 'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations'

describe('normaliseTeamsLink', () => {
  test.each([
    [JOIN, JOIN],
    [lower, JOIN],
    [`  ${JOIN}\n`, JOIN],
    [`${JOIN}&anon=true&deeplinkId=TESTDEEPLINK`, JOIN],
    [`${JOIN}#ignored`, JOIN],
    [`HTTPS://Teams.Microsoft.com/l/meetup-join/${THREAD}/0?context=${CONTEXT}`, JOIN],
    [`https://teams.microsoft.com/l/meetup-join/${THREAD}/0`, `https://teams.microsoft.com/l/meetup-join/${THREAD}/0`],
    [`https://teams.microsoft.com/_#${hashPath}`, JOIN],
    [`https://teams.microsoft.com/v2/?meetingjoin=true#${hashPath}`, JOIN],
    [
      `https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(`/_#${hashPath}`)}&type=meetup-join&directDl=true`,
      JOIN
    ],
    [`https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(hashPath)}`, JOIN],
    [safelink(JOIN), JOIN],
    [safelink(safelink(JOIN)), JOIN],
    [safelink(`https://teams.microsoft.com/_#${hashPath}`), JOIN],
    [MEET, MEET],
    [
      'https://teams.live.com/meet/9876543210987?p=TESTPASS&anon=true',
      'https://teams.live.com/meet/9876543210987?p=TESTPASS'
    ],
    ['https://teams.live.com/meet/9876543210987', 'https://teams.live.com/meet/9876543210987'],
    [safelink(MEET), MEET]
  ])('normalises %s', (input, expected) => {
    expect(normaliseTeamsLink(input)).toBe(expected)
  })

  test.each([
    CHAT,
    'https://teams.microsoft.com/l/channel/19%3ATESTCHANNEL%40thread.tacv2/General',
    'https://teams.microsoft.com/meet/not-digits',
    'https://teams.microsoft.com/meet/123/extra',
    'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_X%40thread.v2/notdigits',
    'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_X%40thread.v2',
    'https://teams.microsoft.com/l/meetup-join/not-a-thread/0',
    'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_X%40thread.v2%2Fextra/0',
    'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_X%40thread.v2%/0',
    'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_X%40thread.v2%00/0',
    'https://teams.microsoft.com/dl/launcher/launcher.html',
    'https://zoom.us/j/1234567890?pwd=TESTPASS',
    'not a url',
    ''
  ])('rejects %s', (input) => {
    expect(normaliseTeamsLink(input)).toBeNull()
  })

  test('look-alike hosts, other subdomains and other schemes are refused', () => {
    for (const host of [
      'teams.microsoft.com.evil.example',
      'evilteams.microsoft.com',
      'evil-teams.microsoft.com',
      'teams.microsoft.com.',
      'foo.teams.microsoft.com',
      'teams.live.com.evil.example',
      'xteams.live.com',
      'microsoft.com',
      'teams.microsoft.co',
      'teams.microsoft.com@evil.example'
    ]) {
      expect(normaliseTeamsLink(`https://${host}/meet/1234567890123?p=x`)).toBeNull()
      expect(normaliseTeamsLink(`https://${host}/l/meetup-join/${THREAD}/0`)).toBeNull()
    }
    expect(normaliseTeamsLink(JOIN.replace('https:', 'http:'))).toBeNull()
    expect(normaliseTeamsLink(JOIN.replace('https:', 'ftp:'))).toBeNull()
  })

  test('userinfo and ports are refused', () => {
    expect(normaliseTeamsLink(MEET.replace('https://', 'https://user:pass@'))).toBeNull()
    expect(normaliseTeamsLink(MEET.replace('https://', 'https://user@'))).toBeNull()
    expect(normaliseTeamsLink(MEET.replace('.com/', '.com:8443/'))).toBeNull()
    expect(normaliseTeamsLink(JOIN.replace('.com/', '.com:444/'))).toBeNull()
  })

  test('control characters are refused, since the URL parser would strip them', () => {
    expect(normaliseTeamsLink('https://teams.microsoft.com/meet/1234\t567890123')).toBeNull()
    expect(normaliseTeamsLink('https://teams.microsoft.com/meet/1234567890123\n?p=a')).toBeNull()
    expect(normaliseTeamsLink('https://teams.mic\rrosoft.com/meet/1234567890123')).toBeNull()
    expect(normaliseTeamsLink('https://teams.microsoft.com/meet/1234567890123?p=a\u0000b')).toBeNull()
    // An escaped control character is refused too.
    expect(normaliseTeamsLink(MEET.replace('TESTPASS', 'a%00b'))).toBeNull()
  })

  test('a wrapper cannot smuggle in another host', () => {
    const evil = `https://evil.example/_#${hashPath}`
    expect(normaliseTeamsLink(safelink(evil))).toBeNull()
    expect(normaliseTeamsLink(safelink('https://teams.microsoft.com.evil.example/meet/1234567890123'))).toBeNull()
    for (const target of [
      '//evil.example/meet/1234567890123',
      '/\\evil.example/meet/1234567890123',
      'https://evil.example/meet/1'
    ]) {
      expect(
        normaliseTeamsLink(`https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(target)}`)
      ).toBeNull()
    }
    expect(normaliseTeamsLink('https://teams.microsoft.com/_#//evil.example/meet/1234567890123')).toBeNull()
    expect(normaliseTeamsLink('https://teams.microsoft.com/other/#/meet/1234567890123')).toBeNull()
  })

  // The URL parser strips tabs and line breaks from a path, so one decoded out of `url=` would turn a bad link good.
  test.each(['%09', '%0A', '%0D'])('a launcher url= holding %s is refused, plain and in Safe Links', (escape) => {
    const control = decodeURIComponent(escape)
    for (const target of [
      `/_#/l/meetup-join/${THREAD}/${control}0?context=${CONTEXT}`,
      `/l/meet${control}/1234567890123`
    ]) {
      const launcher = `https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(target)}`
      expect(launcher).toContain(escape)
      expect(normaliseTeamsLink(launcher)).toBeNull()
      expect(normaliseTeamsLink(safelink(launcher))).toBeNull()
    }
    const chat = `https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(`/l/chat/19%3ATESTCHAT%40thread.v2/conv${control}ersations`)}`
    expect(normaliseTeamsChatUrl(chat)).toBeNull()
    expect(normaliseTeamsChatUrl(safelink(chat))).toBeNull()
  })

  test('encoded nested links are only peeled by the known wrappers', () => {
    const twice = encodeURIComponent(encodeURIComponent(JOIN))
    expect(normaliseTeamsLink(`https://apc01.safelinks.protection.outlook.com/?url=${twice}`)).toBeNull()
    expect(
      normaliseTeamsLink(
        `https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(encodeURIComponent(hashPath))}`
      )
    ).toBeNull()
    expect(normaliseTeamsLink(`https://teams.microsoft.com/l/meetup-join/19%253Ameeting_X%2540thread.v2/0`)).toBeNull()
    const google = `https://www.google.com/url?q=${encodeURIComponent(JOIN)}`
    expect(normaliseTeamsLink(google)).toBe(JOIN)
  })
})

describe('normaliseTeamsChatUrl', () => {
  test.each([
    [CHAT, CHAT],
    [`${CHAT}?context=%7B%22contextType%22%3A%22chat%22%7D`, CHAT],
    ['https://teams.microsoft.com/l/chat/19%3aTESTCHAT%40thread.v2/conversations', CHAT],
    [safelink(CHAT), CHAT],
    [`https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(`/_#${CHAT.slice(27)}`)}`, CHAT],
    [
      'https://teams.live.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
      'https://teams.live.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations'
    ],
    [
      'https://teams.microsoft.com/l/chat/19:abc_def@unq.gbl.spaces/conversations',
      'https://teams.microsoft.com/l/chat/19%3Aabc_def%40unq.gbl.spaces/conversations'
    ]
  ])('normalises %s', (input, expected) => {
    expect(normaliseTeamsChatUrl(input)).toBe(expected)
  })

  test.each([
    'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0',
    'https://teams.microsoft.com/l/channel/19%3ATESTCHANNEL%40thread.tacv2/General',
    'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2',
    'https://teams.microsoft.com/l/chat/not-a-thread/conversations',
    'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2%/conversations',
    'https://teams.microsoft.com.evil.example/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
    'https://user@teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
    'https://teams.microsoft.com:8443/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
    'http://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
    'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conv\tersations',
    'MSc class group',
    'https://discord.com/channels/1/2'
  ])('rejects %s', (input) => {
    expect(normaliseTeamsChatUrl(input)).toBeNull()
  })
})

describe('normaliseMeetingLink', () => {
  test('dispatches Zoom and Teams links to their own rule', () => {
    expect(normaliseMeetingLink('https://us06web.zoom.us/j/00000000000?pwd=PWD')).toBe(
      'https://us06web.zoom.us/wc/join/00000000000?pwd=PWD'
    )
    expect(normaliseMeetingLink(safelink(JOIN))).toBe(JOIN)
    expect(normaliseMeetingLink(MEET)).toBe(MEET)
  })

  test('Meet links, chats and junk are null until plan 05', () => {
    for (const input of ['https://meet.google.com/abc-defg-hij', CHAT, 'not a url', '']) {
      expect(normaliseMeetingLink(input)).toBeNull()
    }
  })
})
