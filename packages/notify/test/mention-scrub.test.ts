import { expect, test } from 'bun:test'
import { pings } from '../src/index'

const mention = (transcript: string): string =>
  pings.nameMentioned({ entry: 'Data Mining', at: '14:32', transcript, meetingUrl: null, takeOverUrl: null }).message

test('a passcode read aloud as words never reaches the mention ping', () => {
  const spoken = mention('Heegpt, the passcode is one two three four five six, ok?')
  expect(spoken).toContain('Heegpt')
  expect(spoken).not.toMatch(/one two three|five six/)
  expect(spoken).toContain('[removed]')
})

test('a passcode spelled out in digits never reaches the mention ping', () => {
  const spelled = mention('passcode 4 8 1 5 9 2 and then the quiz')
  expect(spelled).not.toMatch(/4 8 1|5 9 2/)
  expect(spelled).toContain('and then the quiz')
  expect(mention('the pass code: seven, seven, zero, nine, one')).not.toMatch(/seven|nine/)
})

test('a typed password never reaches the mention ping', () => {
  const typed = mention('the password hunter2 is on the board')
  expect(typed).not.toContain('hunter2')
  expect(typed).toContain('on the board')
})

test('Zoom, Teams and Meet links never reach the mention ping', () => {
  const zoom = mention('join at zoom.us/j/81234 or us02web.zoom.us/j/81234?pwd=abc')
  const teams = mention('use teams.microsoft.com/l/meetup-join/19%3ameeting or https://teams.live.com/meet/9876')
  const meet = mention('open meet.google.com/abc-defg-hij or g.co/meet/xyz')
  expect(zoom).not.toMatch(/zoom\.us|81234|pwd/)
  expect(teams).not.toMatch(/teams\.|meetup-join|9876/)
  expect(meet).not.toMatch(/meet\.google|abc-defg-hij|g\.co/)
})

test('a percent-encoded join link nested in another link never reaches the mention ping', () => {
  const nested = mention(
    'see https://example.com/redirect?url=https%3A%2F%2Fus02web.zoom.us%2Fj%2F81234%3Fpwd%3Dabc and https://x.example/?u=https%253A%252F%252Fmeet.google.com%252Fabc-defg-hij'
  )
  expect(nested).not.toMatch(/zoom|81234|pwd|meet\.google|abc-defg-hij|%2F|%252F/i)
  expect(nested).toContain('[removed]')
})

test.each([
  ['the passcode for today is 481592', /481592/],
  ['the password for the call is Xk9pQ2', /Xk9pQ2/],
  ['use code 481592 to get in', /481592/],
  ['the join code is Xk9pQ2', /Xk9pQ2/],
  ['dial in with PIN 123 456 789#', /123 456|789/],
  ['the meeting is 4 8 1 5 9 2, ok', /4 8 1|5 9 2/],
  ['call 123 456 7890 to join', /123 456|7890/],
  ['go to evil.com/login and sign in', /evil\.com/],
  ['open evil.com now', /evil\.com/],
  ['join at zoom dot us slash j slash 81234567890', /zoom dot|slash|81234/],
  ['join at zoom dot us slash j slash one two three four five six', /zoom dot|slash|one two/],
  ['go to evil dot com slash login please', /evil dot|slash|login/],
  ['meet dot google dot com slash abc dash defg dash hij', /meet dot|google dot|abc dash/]
])('%p never reaches the mention ping', (said, bad) => {
  const out = mention(`Heegpt, ${said}`)
  expect(out).not.toMatch(bad)
  expect(out).toContain('Heegpt')
  expect(out).toContain('[removed]')
})

test('ordinary speech around a name stays', () => {
  const kept = [
    'what is the dot product of these',
    'use code review to catch that',
    'pin the post to the top',
    'the call is at 3 30, see page 12 of the 2026 report',
    'ten minutes past 10 30 and 11 45'
  ]
  for (const said of kept) expect(mention(`Heegpt, ${said}`)).toContain(said)
})

test('the real passcode of the join link is cut from the quote, spaced out or not, and the ping is capped', () => {
  const ping = (transcript: string) =>
    pings.nameMentioned({
      entry: 'E',
      at: 'now',
      transcript,
      meetingUrl: null,
      takeOverUrl: null,
      passcode: 'AbC123xyz'
    }).message
  expect(ping('Heegpt, the code is A b C 1 2 3 x y z, I think')).not.toMatch(/A b C|123/)
  expect(ping('Heegpt, abc123xyz')).not.toMatch(/abc123xyz/i)
  expect(ping('Heegpt, plain words')).toContain('plain words')
  const long = ping(`Heegpt ${'语'.repeat(1_500)}`)
  expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(3900 + '\n(truncated)'.length)
  expect(long).toEndWith('\n(truncated)')
})
