import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { MeetSelectorsSchema } from '../src/adapters/meet/selectors'
import { SMOKE_ENTRIES } from '../src/smoke/entries'
import { meetSmoke } from '../src/smoke/meet'

process.env.TM_SELECTORS_DIR = resolve(import.meta.dir, '../../../config/selectors')

test('the meet smoke entry is registered and checks only real selector keys', async () => {
  expect(SMOKE_ENTRIES).toContain(meetSmoke)
  const keys = Object.keys(MeetSelectorsSchema.shape.selectors.shape)
  for (const key of Object.values(meetSmoke.checkpoints).flat()) expect(keys).toContain(key)
  const { selectors } = await meetSmoke.selectors()
  expect(Object.keys(selectors)).toEqual(expect.arrayContaining(Object.values(meetSmoke.checkpoints).flat()))
})
