import { expect, test } from 'bun:test'
import { parseWhatsAppPrePlain } from '../../src/watchers/whatsapp-time'

test.each([
  [
    '[14:05, 21/10/2026] Dr Lecturer: ',
    'dmy',
    { sentAt: '2026-10-21T06:05:00.000Z', sender: 'Dr Lecturer', shown: '14:05, 21/10/2026' }
  ],
  [
    '[2:05 pm, 21/10/2026] Dr Lecturer: ',
    'dmy',
    { sentAt: '2026-10-21T06:05:00.000Z', sender: 'Dr Lecturer', shown: '2:05 pm, 21/10/2026' }
  ],
  [
    '[2:05 PM, 10/21/2026] +60 12-345 6789: ',
    'mdy',
    { sentAt: '2026-10-21T06:05:00.000Z', sender: '+60 12-345 6789', shown: '2:05 PM, 10/21/2026' }
  ],
  [
    // A no-break space before PM, as newer ICU versions format it.
    '[2:05 PM, 10/21/2026] Rep: ',
    'mdy',
    { sentAt: '2026-10-21T06:05:00.000Z', sender: 'Rep', shown: '2:05 PM, 10/21/2026' }
  ],
  [
    '[12:30 am, 01/02/2026] Rep: A: ',
    'dmy',
    { sentAt: '2026-01-31T16:30:00.000Z', sender: 'Rep: A', shown: '12:30 am, 01/02/2026' }
  ],
  [
    '[12:00 pm, 01/02/2026] Rep: ',
    'dmy',
    { sentAt: '2026-02-01T04:00:00.000Z', sender: 'Rep', shown: '12:00 pm, 01/02/2026' }
  ],
  ['[14:05, 32/10/2026] Rep: ', 'dmy', null],
  ['[14:05, 31/02/2026] Rep: ', 'dmy', null],
  ['[24:00, 21/10/2026] Rep: ', 'dmy', null],
  ['[13:00 pm, 21/10/2026] Rep: ', 'dmy', null],
  ['[0:30 am, 21/10/2026] Rep: ', 'dmy', null],
  ['hello', 'dmy', null]
] as const)('parseWhatsAppPrePlain(%s, %s)', (attr, order, want) =>
  expect(parseWhatsAppPrePlain(attr, order, 480)).toEqual(want)
)
