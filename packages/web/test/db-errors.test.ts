import { expect, test } from 'bun:test'
import { DbError, safeDbError } from '../db/errors'

test('a bare Postgres error loses its detail and keeps only the SQLSTATE', () => {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint "details_member_key"'), {
    code: '23505',
    detail: 'Key (member_id, key)=(m1, student_id) already exists.'
  })
  const safe = safeDbError(pg)
  expect(safe).toBeInstanceOf(DbError)
  expect((safe as DbError).code).toBe('23505')
  expect(
    JSON.stringify({ ...(safe as object), message: (safe as Error).message, stack: (safe as Error).stack })
  ).not.toContain('student_id')
})

test('an error without a SQLSTATE passes through unchanged', () => {
  const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  expect(safeDbError(e)).toBe(e)
})
