// Test fixtures shared by the packages' tests. Import as `@tm/core/testing`; not exported from the package index.
import { newFormRecord, type FormRecord } from './form-record'
import type { ResolvedForm } from './types'

export const sampleForm: ResolvedForm = {
  url: 'https://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform',
  finalUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform',
  provider: 'google',
  source: 'qr',
  sender: null,
  senderRole: null,
  seenAt: '2026-10-20T12:30:00.000Z'
}

export function sampleRecord(patch: Partial<FormRecord> = {}): FormRecord {
  return { ...newFormRecord(sampleForm, 'occ-1'), ...patch }
}
