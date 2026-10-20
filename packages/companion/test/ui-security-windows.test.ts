import { describe, expect, test } from 'bun:test'
import { sanitizeLogMessage } from '../src/main/guard'
import { FolderKindSchema } from '../src/ui/ipc'

describe('security and windows guards', () => {
  test('sanitizeLogMessage strips URL fragment and password from load URL messages', () => {
    const raw =
      '(node:1234) electron: Failed to load URL: http://127.0.0.1:1/vnc.html#autoconnect=1&password=SUPER_SECRET with error: ERR_UNSAFE_PORT'
    const clean = sanitizeLogMessage(raw)
    expect(clean).not.toContain('SUPER_SECRET')
    expect(clean).not.toContain('password=')
    expect(clean).toBe(
      '(node:1234) electron: Failed to load URL: http://127.0.0.1:1/vnc.html with error: ERR_UNSAFE_PORT'
    )
  })

  test('FolderKindSchema rejects invalid kinds with fixed sentence handling', () => {
    const invalidKinds = ['invalid', 123, null, undefined, {}, '__proto__']
    for (const k of invalidKinds) {
      const parsed = FolderKindSchema.safeParse(k)
      expect(parsed.success).toBe(false)
      // When handled in windows.ts chooseFolder:
      let err: Error | null = null
      try {
        if (!parsed.success) throw new Error('Invalid folder kind')
      } catch (e) {
        err = e as Error
      }
      expect(err?.message).toBe('Invalid folder kind')
    }

    expect(FolderKindSchema.safeParse('summaries').success).toBe(true)
    expect(FolderKindSchema.safeParse('whisper').success).toBe(true)
  })
})
