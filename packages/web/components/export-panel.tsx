'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionSummary, ExportTargetId, ExportView } from '@tm/exports/api'
import { EXPORT_BUTTONS, exportButtonState } from '../lib/export-buttons'
import { Notice } from './Notice'

const POLL_MS = 2_000

const STATUS: Record<ExportView['status'], string> = {
  queued: 'Waiting to start',
  running: 'Exporting',
  succeeded: 'Done',
  failed: 'Failed'
}

const LOAD_FAILED = 'Your exports did not load. Reload the page to try again.'
const START_FAILED = 'The export did not start. Try again.'
const REPLACED = 'This download was replaced by a newer export, so its file is gone.'

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

/**
 * Export buttons and the list of this meeting's exports. It loads the member's connections and exports from the export
 * API, asks again every 2 s while one is waiting or running, and opens a download that this page started once it is
 * done. A target that cannot run is disabled and the sentence beside it says what to do. `timeZone` is the member's.
 */
export function ExportPanel({ occurrenceId, timeZone }: { occurrenceId: string; timeZone: string }) {
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null)
  const [rows, setRows] = useState<ExportView[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const startedHere = useRef(new Set<string>())
  const listUrl = `/api/meetings/${encodeURIComponent(occurrenceId)}/exports`

  const refresh = useCallback(async () => {
    try {
      const [{ connections: found }, { exports }] = await Promise.all([
        getJson<{ connections: ConnectionSummary[] }>('/api/connections'),
        getJson<{ exports: ExportView[] }>(listUrl)
      ])
      setConnections(found)
      setRows(exports)
      for (const row of exports) {
        if (startedHere.current.has(row.id) && row.status !== 'queued' && row.status !== 'running') {
          startedHere.current.delete(row.id)
          if (row.downloadUrl) window.location.assign(row.downloadUrl)
        }
      }
    } catch (e) {
      console.error(e)
      setProblem(LOAD_FAILED)
    }
  }, [listUrl])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const busy = rows?.some((r) => r.status === 'queued' || r.status === 'running') ?? false
  useEffect(() => {
    if (!busy) return
    const timer = setTimeout(() => void refresh(), POLL_MS)
    return () => clearTimeout(timer)
  }, [busy, rows, refresh])

  async function start(target: ExportTargetId) {
    setProblem(null)
    const response = await fetch(listUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target })
    })
    const body = (await response.json()) as { exportId?: string; message?: string }
    if (!response.ok) return setProblem(typeof body.message === 'string' ? body.message : START_FAILED)
    if (body.exportId) startedHere.current.add(body.exportId)
    await refresh()
  }

  const time = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone })
  const newestFirst = [...(rows ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <section aria-labelledby="export-heading">
      <h2 id="export-heading">Export</h2>
      <p>Exports are your own copies. Deleting this meeting, by hand or after 30 days, does not touch them.</p>
      {connections === null || rows === null ? (
        problem === null && <p role="status">Loading your exports…</p>
      ) : (
        <>
          <ul className="list">
            {EXPORT_BUTTONS.map(({ target, label }) => {
              const { enabled, hint } = exportButtonState(target, connections, rows)
              return (
                <li key={target}>
                  <button
                    type="button"
                    disabled={!enabled}
                    aria-describedby={hint ? `export-hint-${target}` : undefined}
                    onClick={() => void start(target)}
                  >
                    {label}
                  </button>
                  {hint && (
                    <>
                      {' '}
                      <span id={`export-hint-${target}`}>{hint}.</span>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
          <p>
            GitHub: exporting again updates the same folder. Google Docs and Notion: each export makes a new copy.
            Connect services on the <Link href="/connections">Connections page</Link>.
          </p>
        </>
      )}
      {problem !== null && <Notice kind="error">{problem}</Notice>}
      {newestFirst.length > 0 && (
        <>
          <h3>Your exports of this meeting</h3>
          <ul className="list">
            {newestFirst.map((row) => (
              <li key={row.id}>
                <strong>{row.label}</strong>: {STATUS[row.status]},{' '}
                <time dateTime={row.createdAt}>{time.format(new Date(row.createdAt))}</time>.
                {row.url !== null && (
                  <>
                    {' '}
                    <a href={row.url} rel="noopener noreferrer">
                      Open the {row.label} page
                    </a>
                    .
                  </>
                )}
                {row.downloadUrl !== null && (
                  <>
                    {' '}
                    <a href={row.downloadUrl}>Download the {row.label} file</a>.
                  </>
                )}
                {row.replaced && <> {REPLACED}</>}
                {row.note !== null && !row.replaced && <> {row.note}</>}
                {row.error !== null && <> {row.error}</>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
