import { expect, test } from 'bun:test'
import { KeepAwake } from '../src/keep-awake'

function blocker() {
  const calls: string[] = []
  return {
    calls,
    start: (t: 'prevent-app-suspension') => (calls.push(`start ${t}`), 1),
    stop: (id: number) => void calls.push(`stop ${id}`)
  }
}

test('the PC is kept awake through one OS request while jobs run', () => {
  const b = blocker()
  const k = new KeepAwake(b)
  const a = k.acquire('j1')
  const c = k.acquire('local')
  expect(k.active).toEqual(['j1', 'local'])
  a()
  a()
  expect(b.calls).toEqual(['start prevent-app-suspension'])
  c()
  expect(b.calls).toEqual(['start prevent-app-suspension', 'stop 1'])
  expect(k.active).toEqual([])
})

test('after everything is released a new holder asks the OS again', () => {
  const b = blocker()
  const k = new KeepAwake(b)
  k.acquire('a')()
  k.acquire('b')()
  expect(b.calls).toEqual(['start prevent-app-suspension', 'stop 1', 'start prevent-app-suspension', 'stop 1'])
})

test('a refused OS request leaves nothing held', () => {
  const k = new KeepAwake({
    start: () => {
      throw new Error('no power API')
    },
    stop: () => {}
  })
  expect(() => k.acquire('j1')).toThrow('no power API')
  expect(k.active).toEqual([])
})

test('the companion never changes power settings', async () => {
  const files = await Array.fromAsync(new Bun.Glob('src/**/*.ts').scan({ cwd: import.meta.dir + '/..' }))
  expect(files.length).toBeGreaterThan(5)
  for (const f of files) expect(await Bun.file(`${import.meta.dir}/../${f}`).text()).not.toMatch(/powercfg/i)
})
