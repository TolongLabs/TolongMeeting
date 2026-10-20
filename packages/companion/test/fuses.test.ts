import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('companion electron fuses configuration', () => {
  test('shipped fuses do not disable grantFileProtocolExtraPrivileges while pages load from file: and enable cookie encryption', async () => {
    // Note: @electron/asar is not listed in dependencies/devDependencies; per instructions, we do not add
    // a new dependency, so we verify the fuse configuration and its constraints directly from package.json.
    const pkgPath = join(import.meta.dir, '../package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const fuses = pkg.build?.electronFuses

    expect(fuses).toBeDefined()
    // grantFileProtocolExtraPrivileges must not be false because pages load from file: in app.asar
    expect(fuses.grantFileProtocolExtraPrivileges).toBeUndefined()
    expect(fuses.enableCookieEncryption).toBe(true)
    expect(fuses.onlyLoadAppFromAsar).toBe(true)
    expect(fuses.runAsNode).toBe(false)
  })
})
