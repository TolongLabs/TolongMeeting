import { z } from 'zod'
import {
  createNotionClient,
  MESSAGES,
  notionId,
  notionPageIdFromUrl,
  NotionApiError,
  NotionPageSchema,
  parseNotion,
  type NotionClient
} from '../connections/notion'
import { bundleDocument } from '../render/doc'
import { bundleImages } from '../render/images'
import { chunkBlocks, toNotionBlocks, type NotionBlock } from '../render/notion'
import { ExportError, type ExportResult, type ExportTarget, type NotionParent, type OAuthClient } from '../types'
import { renderGuard } from './guard'

// One Notion page per meeting under the parent the member chose.
//
// First export: create the page (title only), upload the slide images from the re-encoded JPEG bytes (the page never
// links to our server), append the blocks in chunks that respect Notion's limits, and trash the page if any step after
// its creation fails, so no half-written page is left.
//
// Re-export: the page this member's earlier export created (its address, kept in the export row) is updated in place.
// Its old blocks are listed, the new ones appended after them and only then are the old ones deleted, so the page is
// whole at every step but the last; a failure removes the blocks just appended. An id that did not come from that row
// is never written to, and a page that is gone, trashed or no longer under the chosen parent is not touched: a new
// page is made instead.

const MAX_TITLE_CHARS = 2000
const MAX_LISTED_PAGES = 200
/** Blocks the member added by hand as sub-pages stay when a page is updated. */
const KEEP_TYPES = new Set(['child_page', 'child_database'])

const Appended = z.object({ results: z.array(z.object({ id: z.string() })).optional() })
const Children = z.object({
  results: z.array(z.object({ id: z.string(), type: z.string().optional() })),
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullish()
})

interface Page {
  id: string
  url: string
}

function title(bundleTitle: string): string {
  return bundleTitle
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
}

/** An https address: a page URL from Notion that is anything else is not passed on. */
function httpsUrl(raw: string | undefined): string {
  if (raw !== undefined) {
    try {
      if (new URL(raw).protocol === 'https:') return raw
    } catch {
      // Falls through to the error below.
    }
  }
  throw new ExportError('failed', MESSAGES.odd)
}

function parentBody(parent: NotionParent): Record<string, string> {
  return parent.type === 'page_id'
    ? { type: 'page_id', page_id: parent.id }
    : { type: 'data_source_id', data_source_id: parent.id }
}

function sameParent(page: z.infer<typeof NotionPageSchema>, parent: NotionParent): boolean {
  const actual = page.parent?.[parent.type]
  return typeof actual === 'string' && page.parent?.type === parent.type && notionId(actual) === parent.id
}

/** The page an earlier export of this meeting made, if it is still there and still under `parent`; else null. */
async function findOwnPage(client: NotionClient, id: string, parent: NotionParent): Promise<Page | null> {
  let raw: unknown
  try {
    raw = await client.request('GET', `/v1/pages/${id}`)
  } catch (e) {
    if (e instanceof NotionApiError && (e.status === 403 || e.status === 404)) return null
    throw e
  }
  const page = parseNotion(NotionPageSchema, raw)
  if (notionId(page.id) !== id || page.in_trash || page.archived || !sameParent(page, parent)) return null
  return { id, url: httpsUrl(page.url) }
}

async function oldBlocks(client: NotionClient, pageId: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null | undefined
  for (let i = 0; i < MAX_LISTED_PAGES; i++) {
    const query = `page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`
    const list = parseNotion(Children, await client.request('GET', `/v1/blocks/${pageId}/children?${query}`))
    for (const block of list.results) {
      const id = notionId(block.id)
      if (id !== null && !KEEP_TYPES.has(block.type ?? '')) ids.push(id)
    }
    if (!list.has_more || !list.next_cursor) return ids
    cursor = list.next_cursor
  }
  throw new ExportError('failed', 'The Notion page holds too much to update. Delete it in Notion and export again.')
}

/** Deletes blocks one by one. With `quiet`, a failure is ignored (cleanup after an error must not hide that error). */
async function deleteBlocks(client: NotionClient, ids: string[], quiet: boolean): Promise<void> {
  for (const id of ids) {
    try {
      await client.request('DELETE', `/v1/blocks/${id}`)
    } catch (e) {
      if (!quiet) throw e
    }
  }
}

export function createNotionTarget(oauth: OAuthClient): ExportTarget {
  return {
    id: 'notion',
    async run(bundle, ctx): Promise<ExportResult> {
      const conn = ctx.connection
      if (conn?.kind !== 'notion')
        throw new ExportError('not_connected', 'Connect Notion on the Connections page first.')
      const parent = conn.parent
      if (parent === null)
        throw new ExportError('invalid_settings', 'Pick a Notion page or database for exports on the Connections page.')
      if (notionId(parent.id) !== parent.id) throw new ExportError('invalid_settings', MESSAGES.badParent)
      const client = createNotionClient(conn, {
        http: ctx.http,
        sleep: ctx.sleep,
        saveConnection: (c) => ctx.saveConnection(c),
        client: oauth
      })

      // Everything that needs no network is done before the first call.
      const doc = await renderGuard(() => bundleDocument(bundle))
      const images = await bundleImages(bundle)

      const previousId = notionPageIdFromUrl(ctx.previousUrl)
      let page = previousId === null ? null : await findOwnPage(client, previousId, parent)
      const updating = page !== null
      if (page === null) {
        let created: unknown
        try {
          created = await client.request('POST', '/v1/pages', {
            parent: parentBody(parent),
            properties: { [parent.titleProperty]: { title: [{ text: { content: title(bundle.title) } }] } }
          })
        } catch (e) {
          if (e instanceof NotionApiError && (e.status === 403 || e.status === 404)) {
            const noun = parent.type === 'page_id' ? 'page' : 'database'
            throw new ExportError(
              'not_found',
              `TolongMeeting can't reach the Notion ${noun} "${parent.name}" any more. Share it with the TolongLabs integration again, or pick another on the Connections page.`
            )
          }
          throw e
        }
        const made = parseNotion(NotionPageSchema, created)
        const id = notionId(made.id)
        if (id === null) throw new ExportError('failed', MESSAGES.odd)
        page = { id, url: httpsUrl(made.url) }
      }

      const appended: string[] = []
      let before: string[] = []
      try {
        if (updating) before = await oldBlocks(client, page.id)
        const uploads = new Map<string, string>()
        for (const [path, jpeg] of images) {
          const number = /^slides\/(\d{2,3})\.webp$/.exec(path)?.[1]
          uploads.set(path, await client.upload(`slide-${number}.jpg`, jpeg.bytes, 'image/jpeg'))
        }
        const blocks: NotionBlock[] = await renderGuard(() => toNotionBlocks(doc, uploads))
        for (const children of chunkBlocks(blocks)) {
          const answer = parseNotion(
            Appended,
            await client.request('PATCH', `/v1/blocks/${page.id}/children`, { children })
          )
          for (const block of answer.results ?? []) appended.push(block.id)
        }
      } catch (e) {
        // Leave nothing half-written: a page this export made is trashed; a page it updated loses only what it added.
        if (updating) await deleteBlocks(client, appended, true)
        else await client.request('PATCH', `/v1/pages/${page.id}`, { in_trash: true }).catch(() => undefined)
        throw e
      }
      // Only now is the earlier content removed. A failure here leaves the old and the new together, never less.
      await deleteBlocks(client, before, false)
      return { url: page.url, filePath: null, note: null }
    }
  }
}
