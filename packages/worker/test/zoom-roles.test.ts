import { describe, expect, test } from 'bun:test'
import { resolveZoomRole, roleFromZoomLabel, type ZoomRosterEntry } from '../src/adapters/zoom/roles'

describe('resolveZoomRole', () => {
  test('real host alone in roster is trusted as host', () => {
    const roster: ZoomRosterEntry[] = [{ name: 'Dr Example', role: '(Host)', fullText: 'Dr Example (Host)' }]
    expect(resolveZoomRole('Dr Example (Host)', roster)).toBe('host')
  })

  test('real co-host alone in roster is trusted as co_host', () => {
    const roster: ZoomRosterEntry[] = [{ name: 'Dr Assistant', role: '(Co-host)', fullText: 'Dr Assistant (Co-host)' }]
    expect(resolveZoomRole('Dr Assistant (Co-host)', roster)).toBe('co_host')
  })

  test('spoofer named "Dr Example (Host)" alongside real host makes both untrusted', () => {
    const roster: ZoomRosterEntry[] = [
      { name: 'Dr Example', role: '(Host)', fullText: 'Dr Example (Host)' },
      { name: 'Dr Example (Host)', role: '', fullText: 'Dr Example (Host)' }
    ]
    expect(resolveZoomRole('Dr Example (Host)', roster)).toBe('unknown')
  })

  test('participant whose name element contains "(Host)" is never host', () => {
    const roster: ZoomRosterEntry[] = [{ name: 'Student (Host)', role: '(Host)', fullText: 'Student (Host) (Host)' }]
    expect(resolveZoomRole('Student (Host) (Host)', roster)).toBe('unknown')
  })

  test('participant whose name element contains "(Co-host)" is never host', () => {
    const roster: ZoomRosterEntry[] = [
      { name: 'Student (Co-host)', role: '(Co-host)', fullText: 'Student (Co-host) (Co-host)' }
    ]
    expect(resolveZoomRole('Student (Co-host) (Co-host)', roster)).toBe('unknown')
  })

  test('regular participant without host label is participant', () => {
    const roster: ZoomRosterEntry[] = [
      { name: 'Dr Example', role: '(Host)', fullText: 'Dr Example (Host)' },
      { name: 'Student A', role: '', fullText: 'Student A' }
    ]
    expect(resolveZoomRole('Student A', roster)).toBe('participant')
  })

  test('student with lecturer name but no host label is participant', () => {
    const roster: ZoomRosterEntry[] = [
      { name: 'Dr Example', role: '(Host)', fullText: 'Dr Example (Host)' },
      { name: 'Dr Example', role: '', fullText: 'Dr Example' }
    ]
    expect(resolveZoomRole('Dr Example', roster)).toBe('participant')
  })

  test('unreadable / null roster gives unknown for host claims', () => {
    expect(resolveZoomRole('Dr Example (Host)', null)).toBe('unknown')
  })

  test('unreadable / null roster gives participant for normal sender', () => {
    expect(resolveZoomRole('Student A', null)).toBe('participant')
  })
})

describe('roleFromZoomLabel', () => {
  test('maps role labels accurately', () => {
    expect(roleFromZoomLabel('(Host)')).toBe('host')
    expect(roleFromZoomLabel('Host')).toBe('host')
    expect(roleFromZoomLabel('(Co-host)')).toBe('co_host')
    expect(roleFromZoomLabel('Co-host')).toBe('co_host')
    expect(roleFromZoomLabel('Attendee')).toBeNull()
    expect(roleFromZoomLabel('')).toBeNull()
  })
})
