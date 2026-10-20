import { expect, test } from 'bun:test'
import { canonicalFormUrl, formIdFor, FormRecordSchema, isFormPageUrl, isPlainHttpsUrl, newFormRecord } from '@tm/core'
import { sampleForm, sampleRecord } from '@tm/core/testing'

const G = 'https://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform'
const MS = 'https://forms.office.com/Pages/ResponsePage.aspx?id=AbC_1'

test('canonicalFormUrl drops prefilled answers and direct-submit paths', () => {
  expect(canonicalFormUrl(`${G}?usp=pp_url&entry.111=Absent`)).toBe(G)
  expect(
    canonicalFormUrl('https://docs.google.com/forms/d/e/1FAIpQLSf-x/formResponse?entry.111=Present&submit=Submit')
  ).toBe(G)
  expect(canonicalFormUrl('https://docs.google.com/forms/u/1/d/e/1FAIpQLSf-x/viewform#i1')).toBe(G)
  expect(canonicalFormUrl('https://FORMS.office.com/Pages/ResponsePage.aspx?id=AbC_1&r1a2b=Absent&embed=true')).toBe(MS)
  expect(canonicalFormUrl('https://forms.office.com/r/XyZ123?origin=lprLink')).toBe('https://forms.office.com/r/XyZ123')
})

test('opening a canonical URL never submits or carries answers', () => {
  const risky = [
    `${G}?usp=pp_url&entry.111=Absent&entry.222=Present`,
    `${G}?usp=pp_url&entry.111=Absent&submit=Submit`,
    'https://docs.google.com/forms/d/e/1FAIpQLSf-x/formResponse?usp=pp_url&entry.111=Absent&submit=Submit',
    'https://docs.google.com/forms/u/0/d/e/1FAIpQLSf-x/formResponse?entry.111=Absent&submit=Submit#response',
    'https://docs.google.com/forms/d/1AbCdEf/formResponse?entry.5=x&submit=Submit',
    `${MS}&r1a2b3c=Absent&r9=Present`,
    'https://forms.microsoft.com/Pages/ResponsePage.aspx?id=AbC_1&r1a2b3c=Absent&submit=1',
    'https://forms.office.com/r/XyZ123?r1a2b3c=Absent&origin=lprLink'
  ]
  for (const url of risky) {
    const canonical = canonicalFormUrl(url)
    const u = new URL(canonical)
    expect(u.pathname).not.toContain('formResponse')
    expect(u.hash).toBe('')
    expect([...u.searchParams.keys()].filter((key) => key !== 'id')).toEqual([])
    expect(canonical).not.toMatch(/entry\.|submit|Absent|Present|usp=/)
  }
  expect(canonicalFormUrl('https://docs.google.com/forms/d/1AbCdEf/formResponse?entry.5=x')).toBe(
    'https://docs.google.com/forms/d/1AbCdEf/viewform'
  )
  expect(canonicalFormUrl('https://forms.microsoft.com/Pages/ResponsePage.aspx?id=AbC_1&r1a2b3c=Absent')).toBe(MS)
})

test('canonicalFormUrl is idempotent and keeps different forms apart', () => {
  for (const url of [G, MS, 'https://forms.office.com/r/XyZ123', 'https://forms.gle/abc']) {
    expect(canonicalFormUrl(canonicalFormUrl(url))).toBe(canonicalFormUrl(url))
  }
  expect(canonicalFormUrl(`${G}?x=1`)).not.toBe(canonicalFormUrl(G.replace('1FAIpQLSf-x', 'OTHER')))
  expect(canonicalFormUrl('https://forms.office.com/r/AbC')).not.toBe(
    canonicalFormUrl('https://forms.office.com/r/abc')
  )
})

test('formIdFor is the same for every variant of one form', () => {
  const id = formIdFor(`${G}?usp=sf_link`)
  expect(id).toMatch(/^[0-9a-f]{16}$/)
  expect(formIdFor('https://docs.google.com/forms/d/e/1FAIpQLSf-x/formResponse')).toBe(id)
  expect(formIdFor('https://docs.google.com/forms/d/e/OTHER/viewform')).not.toBe(id)
})

test('newFormRecord starts detected and FormRecordSchema accepts it', () => {
  const r = newFormRecord(
    {
      url: G,
      finalUrl: G,
      provider: 'google',
      source: 'qr',
      sender: null,
      senderRole: null,
      seenAt: '2026-10-20T12:30:00.000Z'
    },
    'occ-1'
  )
  expect(r).toMatchObject({
    formId: formIdFor(G),
    state: 'detected',
    history: [{ state: 'detected', at: '2026-10-20T12:30:00.000Z' }],
    fieldsFilled: [],
    pings: []
  })
  expect(FormRecordSchema.parse(r)).toEqual(r)
  expect(() => FormRecordSchema.parse({ ...r, state: 'pinged' })).toThrow()
})

test('the sample fixtures are valid records and take a patch', () => {
  expect(sampleForm.source).toBe('qr')
  expect(FormRecordSchema.parse(sampleRecord())).toEqual(sampleRecord())
  const patched = sampleRecord({ state: 'submitted', reason: 'captcha' })
  expect(patched).toMatchObject({ occurrenceId: 'occ-1', state: 'submitted', reason: 'captcha' })
  expect(() => FormRecordSchema.parse({ ...patched, reason: 'nope' })).toThrow()
})

test('isFormPageUrl accepts only https pages of the two form hosts', () => {
  for (const url of [
    G,
    MS,
    'https://docs.google.com/forms/u/0/d/e/1FAIpQLSf-x/viewform',
    'https://forms.office.com/r/XyZ123'
  ]) {
    expect(isFormPageUrl(url)).toBe(true)
  }
  const refused = [
    'http://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform',
    'https://docs.google.com:8443/forms/d/e/1FAIpQLSf-x/viewform',
    'https://user:pw@docs.google.com/forms/d/e/1FAIpQLSf-x/viewform',
    'https://docs.google.com/drive/x',
    'https://docs.google.com/formsx/d/e/1FAIpQLSf-x/viewform',
    'https://forms.gle/abc',
    'https://forms.microsoft.com/r/XyZ123',
    'https://forms.office.com.evil.com/r/XyZ123',
    'javascript:alert(1)',
    'not a url'
  ]
  for (const url of refused) expect(isFormPageUrl(url)).toBe(false)
})

test('isFormPageUrl stops at 300 characters', () => {
  const pad = (length: number) =>
    `https://forms.office.com/r/${'a'.repeat(length - 'https://forms.office.com/r/'.length)}`
  expect(isFormPageUrl(pad(300))).toBe(true)
  expect(isFormPageUrl(pad(301))).toBe(false)
})

test('isPlainHttpsUrl refuses other schemes, ports and credentials', () => {
  expect(isPlainHttpsUrl(G)).toBe(true)
  expect(isPlainHttpsUrl('http://docs.google.com/x')).toBe(false)
  expect(isPlainHttpsUrl('https://docs.google.com:8443/x')).toBe(false)
  expect(isPlainHttpsUrl('https://u@docs.google.com/x')).toBe(false)
  expect(isPlainHttpsUrl('not a url')).toBe(false)
})
