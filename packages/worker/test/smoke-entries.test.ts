import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { TeamsSelectorsSchema } from '../src/adapters/teams'
import { ZoomSelectorsSchema } from '../src/adapters/zoom'
import { SMOKE_ENTRIES } from '../src/smoke/entries'
import { teamsSmoke } from '../src/smoke/teams'
import { zoomSmoke } from '../src/smoke/zoom'

process.env.TM_SELECTORS_DIR = resolve(import.meta.dir, '../../../config/selectors')

test('the zoom and teams smoke entries are registered', () => {
  expect(SMOKE_ENTRIES.map((e) => e.platform)).toEqual(expect.arrayContaining(['zoom', 'teams']))
})

test('the teams smoke entry checks only real selector keys', async () => {
  const keys = Object.keys(TeamsSelectorsSchema.shape.selectors.shape)
  for (const key of Object.values(teamsSmoke.checkpoints).flat()) expect(keys).toContain(key)
  const { selectors } = await teamsSmoke.selectors()
  expect(Object.keys(selectors)).toEqual(expect.arrayContaining(Object.values(teamsSmoke.checkpoints).flat()))
})

test('the zoom smoke entry checks only real selector keys', async () => {
  const keys = Object.keys(ZoomSelectorsSchema.shape.selectors.shape)
  for (const key of Object.values(zoomSmoke.checkpoints).flat()) expect(keys).toContain(key)
  const { selectors } = await zoomSmoke.selectors()
  expect(Object.keys(selectors)).toEqual(expect.arrayContaining(Object.values(zoomSmoke.checkpoints).flat()))
})
