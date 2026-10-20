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
