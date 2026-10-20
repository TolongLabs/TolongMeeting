import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  checkFolder,
  DOC_MIME,
  DRIVE_API,
  DRIVE_ORIGIN,
  DRIVE_UPLOAD,
  driveFailure,
  ensureDefaultFolder,
  FOLDER_GONE_MESSAGE,
  googleSession,
  isDriveId,
  type GoogleSession
} from '../connections/google'
import { bundleDocument } from '../render/doc'
import { toDocx } from '../render/docx'
import { bundleImages } from '../render/images'
import { ExportError, type ExportBundle, type ExportResult, type ExportTarget, type OAuthClient } from '../types'

// Uploads the meeting as a Word file and lets Drive convert it to a Google Doc (`mimeType` of the new file is the Docs
// type; the media is a .docx). The first export creates the Doc in the member's folder and marks it with a private app
// property (visible to this OAuth client only). A re-export looks for a live Doc with that mark and replaces its content;
// it never touches a file without the mark. With the `drive.file` scope Drive shows this app only files it created or
// that the member picked, which is a second fence.

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MARK_KEY = 'tmMeeting'

const Listing = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      mimeType: z.string(),
      trashed: z.boolean().optional(),
      ownedByMe: z.boolean().optional(),
      appProperties: z.record(z.string(), z.string()).optional()
    })
  )
})
const Uploaded = z.object({ id: z.string(), mimeType: z.string() })

/** One meeting of one member has one mark. Hashed, so a long title fits Drive's 124-byte limit on a property. */
function meetingMark(memberId: string, dirName: string): string {
  return createHash('sha256').update(`${memberId}\n${dirName}`).digest('hex')
}

async function findOwnDoc(session: GoogleSession, mark: string): Promise<string | null> {
  const q = `appProperties has { key='${MARK_KEY}' and value='${mark}' } and mimeType = '${DOC_MIME}' and trashed = false`
  const query = new URLSearchParams({
    q,
    fields: 'files(id,mimeType,trashed,ownedByMe,appProperties)',
    pageSize: '10',
    spaces: 'drive'
  })
  const res = await session.fetch(`${DRIVE_API}/files?${query}`)
  if (!res.ok) throw await driveFailure(res, session)
  const parsed = Listing.safeParse(await res.json())
  if (!parsed.success) throw new ExportError('failed', 'Google sent an answer TolongMeeting did not understand.')
  const own = parsed.data.files.find(
    (f) =>
      f.mimeType === DOC_MIME &&
      f.trashed !== true &&
      f.ownedByMe !== false &&
      f.appProperties?.[MARK_KEY] === mark &&
      isDriveId(f.id)
  )
  return own?.id ?? null
}

/** The session address Drive returns must stay on Google's upload path, or the bytes would go somewhere else. */
function uploadSessionUrl(location: string | null): string {
  const url = location === null ? null : URL.parse(location)
  if (url === null || url.origin !== DRIVE_ORIGIN || !url.pathname.startsWith('/upload/drive/v3/files'))
    throw new ExportError('failed', 'Google sent an answer TolongMeeting did not understand.')
  return url.toString()
}

async function upload(
  session: GoogleSession,
  o: { docId: string | null; metadata: object; bytes: Uint8Array }
): Promise<string> {
  const fields = encodeURIComponent('id,mimeType')
  const init = o.docId === null ? `${DRIVE_UPLOAD}/files` : `${DRIVE_UPLOAD}/files/${encodeURIComponent(o.docId)}`
  const started = await session.fetch(`${init}?uploadType=resumable&fields=${fields}`, {
    method: o.docId === null ? 'POST' : 'PATCH',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': DOCX_MIME,
      'X-Upload-Content-Length': String(o.bytes.length)
    },
    body: JSON.stringify(o.metadata)
  })
  if (!started.ok) throw await driveFailure(started, session)
  await started.body?.cancel()
  const sent = await session.fetch(uploadSessionUrl(started.headers.get('location')), {
    method: 'PUT',
    headers: { 'Content-Type': DOCX_MIME },
    body: new Blob([o.bytes as Uint8Array<ArrayBuffer>])
  })
  if (!sent.ok) throw await driveFailure(sent, session)
  const parsed = Uploaded.safeParse(await sent.json())
  if (!parsed.success || parsed.data.mimeType !== DOC_MIME || !isDriveId(parsed.data.id))
    throw new ExportError('failed', 'Google did not make a Google Doc from the upload.')
  return parsed.data.id
}

export function createGdocsTarget(client: OAuthClient): ExportTarget {
  return {
    id: 'gdocs',
    async run(bundle: ExportBundle, ctx): Promise<ExportResult> {
      const c = ctx.connection
      if (c?.kind !== 'google')
        throw new ExportError('not_connected', 'Connect Google Docs on the Connections page first.')
      const session = googleSession({ refreshToken: c.refreshToken, client, http: ctx.http })

      let folderId = c.folderId
      const folder = await checkFolder(session, c.folderId)
      if (!folder.ok) {
        // A default folder is ours to remake; a folder the member picked is theirs, so they pick another.
        if (!c.folderIsDefault) throw new ExportError('not_found', FOLDER_GONE_MESSAGE)
        const made = await ensureDefaultFolder(session)
        folderId = made.id
        await ctx.saveConnection({ ...c, folderId: made.id, folderName: made.name, folderIsDefault: true })
      }

      const bytes = await toDocx(bundleDocument(bundle), await bundleImages(bundle), bundle.title)
      const mark = meetingMark(ctx.memberId, bundle.dirName)
      const existing = await findOwnDoc(session, mark)
      const docId = await upload(session, {
        docId: existing,
        metadata:
          existing === null
            ? { name: bundle.title, mimeType: DOC_MIME, parents: [folderId], appProperties: { [MARK_KEY]: mark } }
            : { name: bundle.title },
        bytes
      })
      return { url: `https://docs.google.com/document/d/${docId}/edit`, filePath: null, note: null }
    }
  }
}
