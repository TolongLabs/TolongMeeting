import { expect, test } from 'bun:test'
import { buttonState, type ConnectionSummary, type ExportTargetId, type ExportView } from '@tm/exports/api'
import { EXPORT_BUTTONS, exportButtonState } from '../lib/export-buttons'

// The export panel is a client component and cannot import `buttonState`, so it has its own copy of the rule. Every
// button, connection state and running export must give the same answer as the original.
const kinds = ['github', 'google', 'notion'] as const
const summaries: (ConnectionSummary | null)[] = [
  null,
  ...kinds.flatMap((kind) => [
    { kind, status: 'ok', ready: true, label: 'x', detail: '' } as const,
    { kind, status: 'ok', ready: false, label: 'x', detail: '' } as const,
    { kind, status: 'reconnect_needed', ready: false, label: 'x', detail: '' } as const
  ])
]

test('the panel decides a button the way the export API does', () => {
  for (const { target } of EXPORT_BUTTONS) {
    for (const summary of summaries) {
      for (const running of [false, true]) {
        const connections = summary ? [summary] : []
        const rows: Pick<ExportView, 'target' | 'status'>[] = running ? [{ target, status: 'running' }] : []
        expect(exportButtonState(target, connections, rows)).toEqual(buttonState(target, connections, rows))
      }
    }
  }
})

test('there is one button for each export target', () => {
  const targets: ExportTargetId[] = ['zip', 'pdf', 'github', 'gdocs', 'notion']
  expect(EXPORT_BUTTONS.map((b) => b.target)).toEqual(targets)
})
