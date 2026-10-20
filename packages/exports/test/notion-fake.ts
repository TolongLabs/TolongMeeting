import type { NotionConnection, NotionParent, OAuthClient } from '../src/types'
import { json, routeFetch, type Route } from './route-fetch'

export const ACCESS = 'ntn_test_access_token'
export const REFRESH = 'ntn_test_refresh_token'
export const oauth: OAuthClient = {
  clientId: 'nid',
  clientSecret: 'ns-client-secret',
  redirectUri: 'https://tm.example/api/connections/notion/callback'
}

/** A Notion id that is not just a number, so a test can tell ids apart. */
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
export const PARENT_ID = uuid(0xa1)
export const DS_ID = uuid(0xd5)
export const PAGE_ID = uuid(0x91)
export const pageUrl = (id: string, title = 'Meeting') => `https://www.notion.so/${title}-${id.replaceAll('-', '')}`

export const pageParent: NotionParent = {
  type: 'page_id',
  id: PARENT_ID,
  name: 'Lecture notes',
  titleProperty: 'title'
}
export const dsParent: NotionParent = {
  type: 'data_source_id',
  id: DS_ID,
  name: 'Lecture notes',
  titleProperty: 'Name'
}

export function notionConn(over: Partial<NotionConnection> = {}): NotionConnection {
  return {
    kind: 'notion',
    accessToken: ACCESS,
    refreshToken: REFRESH,
    workspace: 'Notes',
    parent: null,
    ...over
  }
}

export interface NotionFakeOptions {
  /** Routes tried before the defaults. */
  routes?: Route[]
  /** What an existing page's children are, for `GET /v1/blocks/<id>/children`. */
  children?: { id: string; type: string }[]
}

/**
 * A fake Notion API: pages are created as `PAGE_ID`, uploads get numbered ids, an append answers one id per block and
 * everything else succeeds. `routes` go first, so a test can override one answer.
 */
export function notionFake(o: NotionFakeOptions = {}) {
  let uploads = 0
  let blockIds = 0x1000
  const routes: Route[] = [
    ...(o.routes ?? []),
    ['POST', '/v1/pages', () => json({ object: 'page', id: PAGE_ID, url: pageUrl(PAGE_ID) })],
    [
      'POST',
      '/v1/file_uploads',
      () => json({ object: 'file_upload', id: uuid(0x2000 + ++uploads), status: 'pending' })
    ],
    ['POST', /\/v1\/file_uploads\/[^/]+\/send$/, () => json({ object: 'file_upload', status: 'uploaded' })],
    [
      'PATCH',
      /\/v1\/blocks\/[^/]+\/children$/,
      async (req) => {
        const body = (await req.clone().json()) as { children: unknown[] }
        return json({ object: 'list', results: body.children.map(() => ({ object: 'block', id: uuid(++blockIds) })) })
      }
    ],
    [
      'GET',
      /\/v1\/blocks\/[^/]+\/children/,
      () => json({ object: 'list', results: o.children ?? [], has_more: false, next_cursor: null })
    ],
    ['DELETE', /\/v1\/blocks\/[^/]+$/, () => json({ object: 'block' })],
    ['PATCH', /\/v1\/pages\/[^/]+$/, () => json({ object: 'page', in_trash: true })]
  ]
  return routeFetch(routes)
}

/** A page object as `GET /v1/pages/<id>` answers it. */
export function pageObject(id: string, parent: NotionParent, over: Record<string, unknown> = {}) {
  return {
    object: 'page',
    id,
    url: pageUrl(id),
    in_trash: false,
    parent: { type: parent.type, [parent.type]: parent.id },
    properties: { [parent.titleProperty]: { type: 'title', title: [{ plain_text: 'Meeting' }] } },
    ...over
  }
}
