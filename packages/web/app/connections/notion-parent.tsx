'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Notice } from '../../components/Notice'
import { GENERIC_PROBLEM, getJson, putJson, Refused } from './fetch-json'

interface Parent {
  type: 'page_id' | 'data_source_id'
  id: string
  name: string
}

function parentsOf(body: unknown): Parent[] {
  if (typeof body === 'object' && body !== null && 'parents' in body && Array.isArray(body.parents))
    return body.parents as Parent[]
  throw new Refused(GENERIC_PROBLEM)
}

/** "Choose a page": lists what is shared with the integration and saves the one the member picks. */
export function NotionParent(props: { chosen: boolean }) {
  const router = useRouter()
  const [parents, setParents] = useState<Parent[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function guarded(work: () => Promise<void>) {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (e) {
      if (e instanceof Refused) setProblem(e.message)
      else {
        console.error(e)
        setProblem(GENERIC_PROBLEM)
      }
    } finally {
      setBusy(false)
    }
  }

  const load = () => guarded(async () => setParents(parentsOf(await getJson('/api/connections/notion/parents'))))

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const chosen = new FormData(event.currentTarget).get('parent')
    const parent = parents?.find((p) => `${p.type}:${p.id}` === chosen)
    if (!parent) return setProblem('Choose a page or database from the list.')
    void guarded(async () => {
      await putJson('/api/connections/notion/parent', { type: parent.type, id: parent.id })
      setParents(null)
      router.refresh()
    })
  }

  return (
    <>
      {parents === null ? (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {busy ? 'Loading your pages...' : props.chosen ? 'Choose another page' : 'Choose a page'}
        </button>
      ) : parents.length === 0 ? (
        <Notice kind="warn">
          Nothing is shared with TolongLabs in Notion yet. In Notion, open the page, choose its menu, then Connections,
          and add TolongLabs. Then press the button again.{' '}
          <button type="button" onClick={() => setParents(null)}>
            Close
          </button>
        </Notice>
      ) : (
        <form onSubmit={save}>
          <fieldset>
            <legend>Choose where exports go</legend>
            {parents.map((p) => (
              <p key={`${p.type}:${p.id}`}>
                <label>
                  <input type="radio" name="parent" value={`${p.type}:${p.id}`} /> {p.name}{' '}
                  {p.type === 'page_id' ? '(page)' : '(database)'}
                </label>
              </p>
            ))}
          </fieldset>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving...' : 'Use this page'}
          </button>{' '}
          <button type="button" onClick={() => setParents(null)}>
            Cancel
          </button>
        </form>
      )}
      {problem !== null && <Notice kind="error">{problem}</Notice>}
    </>
  )
}
