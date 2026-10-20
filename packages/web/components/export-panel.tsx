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
const SESSION_ENDED = 'Your session has ended. Reload the page and sign in again.'
const RUNNING_CAP_NOTE =
  'An export has been running for 15 minutes. Polling has stopped. Reload the page to check again.'
const MAX_RUNNING_MS = 15 * 60 * 1_000

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  if (response.redirected || response.status === 401) throw new Error(SESSION_ENDED)
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false
  if (!response.ok || !isJson) throw new Error(`${url} answered ${response.status}`)
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
  const [announcement, setAnnouncement] = useState<string | null>(null)
  const startedHere = useRef(new Set<string>())
  const prevStatuses = useRef<Map<string, ExportView['status']>>(new Map())
  const runningStartRef = useRef<number | null>(null)
  const [runningCapped, setRunningCapped] = useState(false)
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
        const prev = prevStatuses.current.get(row.id)
        if (prev !== undefined && (prev === 'queued' || prev === 'running')) {
          if (row.status === 'succeeded') {
            setAnnouncement(`${row.label} export finished.`)
          } else if (row.status === 'failed') {
            setAnnouncement(`${row.label} export failed.`)
          }
        }
        prevStatuses.current.set(row.id, row.status)
        if (startedHere.current.has(row.id) && row.status !== 'queued' && row.status !== 'running') {
          startedHere.current.delete(row.id)
          if (row.downloadUrl) window.location.assign(row.downloadUrl)
        }
      }
    } catch (e) {
      console.error(e)
      setProblem(e instanceof Error && e.message === SESSION_ENDED ? SESSION_ENDED : LOAD_FAILED)
    }
  }, [listUrl])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const isRunning = rows?.some((r) => r.status === 'running') ?? false
  const busy = rows?.some((r) => r.status === 'queued' || r.status === 'running') ?? false

  useEffect(() => {
    if (isRunning) {
      const now = Date.now()
      const runningRow = rows?.find((r) => r.status === 'running')
      const rowAge = runningRow ? now - new Date(runningRow.createdAt).getTime() : 0
      if (rowAge >= MAX_RUNNING_MS) {
        setRunningCapped(true)
      } else if (runningStartRef.current === null) {
        runningStartRef.current = now
      } else if (now - runningStartRef.current >= MAX_RUNNING_MS) {
        setRunningCapped(true)
      }
    } else {
      runningStartRef.current = null
      setRunningCapped(false)
    }
  }, [isRunning, rows])

  useEffect(() => {
    if (!busy || runningCapped) return
    const timer = setTimeout(() => void refresh(), POLL_MS)
    return () => clearTimeout(timer)
  }, [busy, runningCapped, rows, refresh])

  async function start(target: ExportTargetId) {
    setProblem(null)
    try {
      const response = await fetch(listUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target })
      })
      if (response.redirected || response.status === 401) {
        return setProblem(SESSION_ENDED)
      }
      const isJson = response.headers.get('content-type')?.includes('application/json') ?? false
      if (!response.ok) {
        if (isJson) {
          try {
            const body = (await response.json()) as { message?: string }
            return setProblem(typeof body.message === 'string' ? body.message : START_FAILED)
          } catch {
            return setProblem(START_FAILED)
          }
        }
        return setProblem(START_FAILED)
      }
      if (!isJson) {
        return setProblem(START_FAILED)
      }
      const body = (await response.json()) as { exportId?: string; message?: string }
      if (body.exportId) startedHere.current.add(body.exportId)
      await refresh()
    } catch {
      setProblem(START_FAILED)
    }
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
      {runningCapped && <Notice>{RUNNING_CAP_NOTE}</Notice>}
      <div aria-live="polite">{announcement}</div>
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
