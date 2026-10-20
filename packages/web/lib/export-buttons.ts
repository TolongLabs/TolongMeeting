import type { ConnectionSummary, ExportTargetId, ExportView } from '@tm/exports/api'

// What the export panel offers. The panel is a client component, and `@tm/exports/api` pulls in server-only code
// (the token vault), so the panel cannot call its `buttonState`. This is the same rule over the same types, and
// `test/export-buttons.test.ts` keeps the two equal.

export const EXPORT_BUTTONS: { target: ExportTargetId; label: string; provider: string }[] = [
  { target: 'zip', label: 'Download Markdown (.zip)', provider: 'Markdown zip' },
  { target: 'pdf', label: 'Download PDF', provider: 'PDF' },
  { target: 'github', label: 'Export to GitHub', provider: 'GitHub' },
  { target: 'gdocs', label: 'Export to Google Docs', provider: 'Google Docs' },
  { target: 'notion', label: 'Export to Notion', provider: 'Notion' }
]

const CONNECTION: Record<ExportTargetId, ConnectionSummary['kind'] | null> = {
  zip: null,
  pdf: null,
  github: 'github',
  gdocs: 'google',
  notion: 'notion'
}

/** Whether a button can be pressed, and when it cannot, the sentence that says why. */
export function exportButtonState(
  target: ExportTargetId,
  connections: ConnectionSummary[],
  rows: Pick<ExportView, 'target' | 'status'>[]
): { enabled: boolean; hint: string | null } {
  if (rows.some((r) => r.target === target && (r.status === 'queued' || r.status === 'running')))
    return { enabled: false, hint: 'Exporting' }
  const kind = CONNECTION[target]
  if (kind === null) return { enabled: true, hint: null }
  const label = EXPORT_BUTTONS.find((b) => b.target === target)!.provider
  const found = connections.find((c) => c.kind === kind)
  if (!found) return { enabled: false, hint: `Connect ${label} on the Connections page` }
  if (found.status === 'reconnect_needed') return { enabled: false, hint: `Reconnect ${label} on the Connections page` }
  if (!found.ready) return { enabled: false, hint: `Pick a ${label} page on the Connections page` }
  return { enabled: true, hint: null }
}
