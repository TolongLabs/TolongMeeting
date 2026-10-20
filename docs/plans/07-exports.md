# Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a member export a finished meeting on demand from its meeting page, as a Markdown zip, a PDF, a GitHub commit, a Google Doc or a Notion page, with results and errors shown on the page and pinged.

**Architecture:** A new `packages/exports` workspace holds one `ExportTarget` module per destination, a loader that turns an occurrence's `out/` and `slides/` files into an `ExportBundle`, and one document model shared by the PDF, Word (for the Google Docs import) and Notion renderers. The website only records export requests in a new `exports` table; a new `tm-exports` process claims them one at a time, runs the target, records the result and pings. Connection tokens are sealed with AES-256-GCM in the `connections` table and set up from a new Connections page.

**Tech Stack:** Bun and TypeScript; marked (Markdown lexer); fflate (zip); pdfmake with DejaVu Sans fonts (PDF); docx (Word); sharp (WebP to JPEG); zod; Drizzle, pg and Next.js as set up by plan 01c; GitHub REST API version `2022-11-28`; Google Drive API v3 and Google Picker; Notion API version `2026-03-11` (the newest on 20 October 2026; re-check at build time).

**Spec:** `docs/PRD.md`, `docs/DESIGN.md` and `docs/TRD.md`.

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [File structure](#file-structure)
1.  [Contract additions](#contract-additions)
1.  [Tasks](#tasks)
    1.  [Task 1: Package, types and bundle loader](#task-1-package-types-and-bundle-loader)
    1.  [Task 2: Document model](#task-2-document-model)
    1.  [Task 3: Markdown zip download](#task-3-markdown-zip-download)
    1.  [Task 4: PDF download](#task-4-pdf-download)
    1.  [Task 5: Token vault and stores](#task-5-token-vault-and-stores)
    1.  [Task 6: Export runner and the tm-exports process](#task-6-export-runner-and-the-tm-exports-process)
    1.  [Task 7: Export API and meeting-page panel](#task-7-export-api-and-meeting-page-panel)
    1.  [Task 8: GitHub connection and target](#task-8-github-connection-and-target)
    1.  [Task 9: Word renderer](#task-9-word-renderer)
    1.  [Task 10: Google Docs connection and target](#task-10-google-docs-connection-and-target)
    1.  [Task 11: Notion block renderer](#task-11-notion-block-renderer)
    1.  [Task 12: Notion connection and target](#task-12-notion-connection-and-target)
    1.  [Task 13: Connections page](#task-13-connections-page)
    1.  [Task 14: Milestone acceptance](#task-14-milestone-acceptance)

## Global Constraints

- Exports run only when the member asks; nothing exports automatically (design non-goal "Automatic exports").
- Markdown and PDF downloads are always available and need no connection (decision 21).
- The summary file is named `YYYY-MM-DD HHmm <entry name>.md`, the same name in exports.
- The Markdown set is the summary file, `transcript.md`, `slides.md` with `slides/NN.webp`, and `chat.md`, in the formats of the session's three-file set (`session-record/techniques.md`, "Write-up format: the three-file set"); exports copy the pipeline's files byte for byte.
- Google Docs: one document per meeting, through Google sign-in with only the `https://www.googleapis.com/auth/drive.file` scope (never `drive` or `drive.readonly`); a "TolongMeeting Exports" folder by default, or a folder the member picks with the Google Picker; the OAuth client is owned by TolongLabs and published "In production", so refresh tokens don't expire after 7 days.
- GitHub: commit the set to a repository, folder and branch the member configures, with a fine-grained token limited to that repository; commit headers are conventional and at most 50 characters.
- Notion: one page per meeting under a parent page or database the member shares with the TolongLabs Notion integration (a database is addressed through its data source in the current API).
- Every target implements the one `ExportTarget` interface; results and errors are shown on the meeting page and pinged at normal priority (`'default'`), matching the design's normal-priority "export finished" ping.
- Export tokens are encrypted at rest (AES-256-GCM under a key derived with HKDF from the master key in `TM_MASTER_KEY_FILE`), never logged, never returned by the website's API (the one exception is the one-hour Google access token the Picker needs in the member's own browser), and never put in the query string of the app's own URLs.
- A member reaches only their own meetings, exports and connections; anything else answers 404. Export and connection routes accept the website session only, never a companion device token.
- Exports are the member's own copies: retention (30 days) and "delete now" remove the server-side export records and files with the meeting, and never touch exported documents, pages or commits.
- Re-exporting never edits or deletes an earlier Google Doc or Notion page; GitHub re-exports commit over the same folder, so Git history keeps older versions.
- Pings never contain meeting passcodes or tokens.

## Review Focus

- **Awkward entry names**: names with `/`, `:`, `?`, quotes, accented Malay or 100-plus characters must give a valid zip folder, download file name, repository path and document title, never a path escape or a broken header (tests in tasks 1 and 8).
- **Big meetings**: a 2-hour transcript with paragraphs over 2,000 characters and 60 or more slides must export whole within Notion's 2,000-character, 100-block and 3-requests-per-second limits and GitHub's 80 content-creating requests per minute, rather than fail halfway (tests in tasks 8, 11 and 12).
- **Connections that stopped working**: a revoked Google grant, an expired GitHub token, a Notion integration removed from the page, or a deleted export folder must fail the export with a message that names the fix, flag the connection "Reconnect" and ping, never fail silently (tests in tasks 6, 8, 10 and 12).
- **Double clicks and re-exports**: a second click while an export is queued or running must not start another; exporting to GitHub again must delete stale slide files or report "already up to date"; exporting to Google Docs or Notion again must never edit or delete the member's earlier copy (tests in tasks 5, 7, 8 and 10).
- **Deletion during an export**: a meeting deleted by retention or "delete now" while its export is queued or running must fail with "This meeting has been deleted from TolongMeeting.", write nothing back into the deleted directory, and leave no export rows behind (tests in tasks 3, 5 and 6).

## File structure

```text
packages/exports/
├── package.json, tsconfig.json
├── assets/fonts/                 DejaVuSans.ttf, DejaVuSans-Bold.ttf, DejaVuSans-Oblique.ttf, DejaVuSans-BoldOblique.ttf, LICENSE
├── src/
│   ├── types.ts                  ExportTarget, bundle, connection and error types
│   ├── names.ts                  slugify, contentDisposition
│   ├── bundle.ts                 loadBundle: occurrence files to ExportBundle
│   ├── render/doc.ts             Markdown to DocBlock[] (shared by PDF, Word and Notion)
│   ├── render/images.ts          WebP slides to JPEG
│   ├── render/docx.ts            DocBlock[] to .docx for the Google Docs import
│   ├── render/notion.ts          DocBlock[] to Notion blocks
│   ├── targets/download.ts       writeDownload
│   ├── targets/zip.ts, pdf.ts, github.ts, gdocs.ts, notion.ts
│   ├── connections/oauth.ts      state cookie and PKCE
│   ├── connections/github.ts, google.ts, notion.ts, remove.ts
│   ├── vault.ts                  sealSecret, openSecret, redact
│   ├── store.ts                  Postgres stores
│   ├── api.ts                    route logic for the website
│   ├── registry.ts               buildTargets, oauthClientFromEnv
│   ├── runner.ts                 runExport, runLoop, exportPing
│   └── main.ts                   tm-exports entry point
└── test/                         fixtures/occurrence/, context.ts, memory-stores.ts, fake-fetch.ts
packages/web/
├── db/exports-schema.ts          connections and exports tables
├── lib/exports.ts                store wiring for route handlers
├── app/connections/page.tsx      Connections page
├── app/api/connections/          list, remove, and GitHub, Google and Notion setup routes
├── app/api/meetings/[occurrenceId]/exports/route.ts
├── app/api/exports/[exportId]/file/route.ts
└── components/export-panel.tsx, components/connections/*.tsx
```

## Contract additions

Names this plan adds to [architecture and contracts](../TRD.md), to be copied there when task 1 lands:

- **Package**: `packages/exports` and every type in task 1's `src/types.ts`, including `ExportTarget`.
- **Process**: `tm-exports` (`packages/exports/src/main.ts`), Compose service `exports`, root script `tm-exports`.
- **Tables**: `connections` (columns in task 5; plan 01c only names the table) and `exports` (new).
- **Data directory**: `exports/<exportId>.zip` and `exports/<exportId>.pdf` inside each occurrence directory.
- **Environment variables**: new `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` (web, exports) and `GOOGLE_API_KEY`, `GOOGLE_APP_ID` (web); existing `DATABASE_URL`, `TM_DATA_ROOT`, `TM_MASTER_KEY_FILE` and `TM_PUBLIC_URL` gain the user `exports`.
- **Website routes**: `/connections`, `/api/connections`, `/api/connections/{github,google,notion}` (`DELETE`; `github` also `PUT`), `/api/connections/google/{start,callback,picker,folder}`, `/api/connections/notion/{start,callback,parents,parent}`, `/api/meetings/[occurrenceId]/exports`, `/api/exports/[exportId]/file`.
- **Assumed from plan 01c** (use 01c's real names if they differ, and fix this plan in the same commit): `requireMember(req: Request): Promise<{ id: string }>` (route session helper, throws a 401 response when signed out); `memberNtfyConfig(memberId: string): Promise<NtfyConfig>`; `db` and its type `Db` from `packages/web/db/index.ts`, with tables `members` and `occurrences` (column `state: OccurrenceState`); the meeting page at `packages/web/app/meetings/[occurrenceId]/page.tsx`, served at `/meetings/<occurrenceId>`.

## Tasks

Test helpers that a test calls but no Interfaces block lists are local builders in that test file and return the values the assertions use: `githubConn(token)` is `acme/notes`, branch `main`, folder `meetings`; `googleConn(folderId, isDefault)` has refresh token `1//refresh`, account `member@example.edu` and folder name `TolongMeeting Exports`; `notionConn(over)` has access token `ntn_test`, refresh token `r1`, workspace `Notes` and no parent unless `over` gives one; `pageParent` is `{ type: 'page_id', id: 'PARENT', name: 'Lecture notes', titleProperty: 'title' }` and `dsParent` is `{ type: 'data_source_id', id: 'DS1', name: 'Lecture notes', titleProperty: 'Name' }`; the public URL in tests is `https://tm.example`. Fakes such as `repoFake`, `drive` and `notion` wrap `fakeFetch` (task 8) with canned API responses.

### Task 1: Package, types and bundle loader

**Files:**

- Create: `packages/exports/package.json`, `packages/exports/tsconfig.json`, `packages/exports/src/types.ts`, `packages/exports/src/names.ts`, `packages/exports/src/bundle.ts`
- Create: `packages/exports/test/fixtures/occurrence/` (contents below), `packages/exports/test/fixture.ts`
- Test: `packages/exports/test/names.test.ts`, `packages/exports/test/bundle.test.ts`

**Interfaces:**

- Consumes: the 01a pipeline outputs in an occurrence directory (`out/<YYYY-MM-DD HHmm Entry name>.md`, `out/transcript.md`, `out/slides.md`, `out/chat.md`, `slides/NN.webp`); `OccurrenceState` from `packages/core/src/types.ts`.
- Produces (adds to contracts), `src/types.ts`:

```ts
export type ExportTargetId = 'zip' | 'pdf' | 'github' | 'gdocs' | 'notion'
export type ExportStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type ConnectionKind = 'github' | 'google' | 'notion'
export const TARGET_LABEL: Record<ExportTargetId, string> = {
  zip: 'Markdown zip',
  pdf: 'PDF',
  github: 'GitHub',
  gdocs: 'Google Docs',
  notion: 'Notion'
}
export const TARGET_CONNECTION: Record<ExportTargetId, ConnectionKind | null> = {
  zip: null,
  pdf: null,
  github: 'github',
  gdocs: 'google',
  notion: 'notion'
}

export interface BundleFile {
  path: string
  bytes: Uint8Array
} // relative to the bundle root, e.g. "slides/01.webp"
export interface ExportBundle {
  title: string // summary file name without ".md": "YYYY-MM-DD HHmm <entry name>"
  dirName: string // slugify(title): folder name in zips and repositories
  summaryFile: string // `${title}.md`
  files: BundleFile[] // summary, transcript.md, slides.md, chat.md, slides/NN.webp; only those that exist
}

export interface GitHubConnection {
  kind: 'github'
  token: string
  owner: string
  repo: string
  branch: string
  folder: string
}
export interface GoogleConnection {
  kind: 'google'
  refreshToken: string
  account: string
  folderId: string
  folderName: string
  folderIsDefault: boolean
}
export interface NotionParent {
  type: 'page_id' | 'data_source_id'
  id: string
  name: string
  titleProperty: string
}
export interface NotionConnection {
  kind: 'notion'
  accessToken: string
  refreshToken: string | null
  workspace: string
  parent: NotionParent | null
}
export type Connection = GitHubConnection | GoogleConnection | NotionConnection
export interface ConnectionSummary {
  kind: ConnectionKind
  status: 'ok' | 'reconnect_needed'
  ready: boolean
  label: string
  detail: string
}
export interface OAuthClient {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface ExportContext {
  exportId: string
  memberId: string
  outDir: string // `${occurrence dir}/exports`
  connection: Connection | null
  saveConnection(c: Connection): Promise<void> // rotated tokens, recreated default folder
  http: typeof fetch
  sleep(ms: number): Promise<void>
}
export interface ExportResult {
  url: string | null
  filePath: string | null
  note: string | null
}
export interface ExportTarget {
  readonly id: ExportTargetId
  run(bundle: ExportBundle, ctx: ExportContext): Promise<ExportResult>
}

export type ExportErrorCode =
  | 'not_connected'
  | 'reconnect_needed'
  | 'invalid_settings'
  | 'not_found'
  | 'already_running'
  | 'not_ready'
  | 'meeting_deleted'
  | 'rate_limited'
  | 'interrupted'
  | 'failed'
export class ExportError extends Error {
  // message is shown to the member as it is
  constructor(
    readonly code: ExportErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface OccurrenceInfo {
  id: string
  memberId: string
  state: OccurrenceState
  dataDir: string
}
export interface OccurrenceLookup {
  get(memberId: string, occurrenceId: string): Promise<OccurrenceInfo | null>
} // null unless the member owns it
```

- Produces, `src/names.ts`: `slugify(title: string): string`, `contentDisposition(fileName: string): string`; `src/bundle.ts`: `loadBundle(dataDir: string): Promise<ExportBundle>`; `test/fixture.ts`: `fixture: string` (absolute path of the fixture directory) and `copyFixture(): Promise<string>` (a copy in a fresh `mkdtemp` directory).

- [x] **Step 1: Create the package and the fixture**

`package.json` takes the same name scope as `packages/core` with the bare name `exports`, and lists `marked`, `fflate`, `pdfmake`, `docx`, `sharp` and `zod` as dependencies and `unpdf` as a dev dependency; `tsconfig.json` extends `tsconfig.base.json` like the other packages, and the root `typecheck` script covers the new package. The fixture `packages/exports/test/fixtures/occurrence/` holds placeholder content only (no real names):

- `out/2026-10-20 1400 Data Mining.md`: the lecture template, first line `Data Mining, Week 3 (Tuesday 20 October 2026, 14:00 to 16:00)`, then `Do next: Submit lab 2 (due 27 October 2026, 23:59)`, then `Attendance: submitted at 14:32 (Google Forms) ✓`, and a "To do" list of two items;
- `out/transcript.md`: H1, intro, a `Contents:` list, `## Speakers`, and `## Messages` with two paragraphs, the first `**[00:00:05] Lecturer:** Good afternoon, everyone.`, the second longer than 4,500 characters;
- `out/slides.md`: H1, intro, `Contents:` list, `## Slide 01: Welcome` with `![Slide 01: Welcome](slides/01.webp)` and two lines of text, `## Slide 02: Agenda` with its image line and a 3-row table;
- `out/chat.md`: H1, intro, `## Messages` with `**[2:05 PM] Sender A:** Is the lab due next week?`, a `- **Answer:** Yes, 27 October (transcript 00:41:10, slide 02).` line, and `**[2:07 PM] Sender B:** Thanks <U+1F44D> 谢谢 see you next week`, where `<U+1F44D>` stands for the thumbs-up emoji character itself, written into the file with `\u{1F44D}`;
- `slides/01.webp`, `slides/02.webp`: 64x36 solid-colour images made once with sharp; `slides/slides.json`: `[]`.

- [x] **Step 2: Write the failing tests**

```ts
// names.test.ts
test('slugify', () => {
  expect(slugify('2026-10-20 1400 Data Mining: Week 3 / Lab?')).toBe('2026-10-20-1400-data-mining-week-3-lab')
  expect(slugify('2026-10-20 0900 Pengurusan Café')).toBe('2026-10-20-0900-pengurusan-cafe')
  expect(slugify('???')).toBe('meeting')
  const long = slugify('2026-10-20 0900 ' + 'Kursus Lanjutan '.repeat(10))
  expect(long.length).toBeLessThanOrEqual(80)
  expect(long.endsWith('-')).toBe(false)
})
test('contentDisposition', () => {
  expect(contentDisposition('2026-10-20 1400 Pengurusan Café.zip')).toBe(
    `attachment; filename="2026-10-20 1400 Pengurusan Caf_.zip"; filename*=UTF-8''2026-10-20%201400%20Pengurusan%20Caf%C3%A9.zip`
  )
  expect(contentDisposition('a "b".pdf')).toBe(`attachment; filename="a _b_.pdf"; filename*=UTF-8''a%20%22b%22.pdf`)
})

// bundle.test.ts
test('loads the set in order', async () => {
  const b = await loadBundle(fixture)
  expect(b.title).toBe('2026-10-20 1400 Data Mining')
  expect(b.summaryFile).toBe('2026-10-20 1400 Data Mining.md')
  expect(b.dirName).toBe('2026-10-20-1400-data-mining')
  expect(b.files.map((f) => f.path)).toEqual([
    '2026-10-20 1400 Data Mining.md',
    'transcript.md',
    'slides.md',
    'chat.md',
    'slides/01.webp',
    'slides/02.webp'
  ])
})
test('skips missing optional files', async () => {
  const dir = await copyFixture()
  await rm(join(dir, 'out/chat.md'))
  await rm(join(dir, 'slides'), { recursive: true })
  expect((await loadBundle(dir)).files.map((f) => f.path)).toEqual([
    '2026-10-20 1400 Data Mining.md',
    'transcript.md',
    'slides.md'
  ])
})
test('no summary is not_ready', async () => {
  const dir = await copyFixture()
  await rm(join(dir, 'out/2026-10-20 1400 Data Mining.md'))
  await expect(loadBundle(dir)).rejects.toMatchObject({
    code: 'not_ready',
    message: 'This meeting has no summary yet.'
  })
})
test('the newest summary wins', async () => {
  const dir = await copyFixture()
  await writeFile(join(dir, 'out/2026-10-20 1400 Data Mining Renamed.md'), 'x')
  await utimes(join(dir, 'out/2026-10-20 1400 Data Mining.md'), new Date('2026-10-20'), new Date('2026-10-20'))
  expect((await loadBundle(dir)).title).toBe('2026-10-20 1400 Data Mining Renamed')
})
```

- [x] **Step 3: Run them to see them fail**

Run: `bun test packages/exports`
Expected: FAIL with `Cannot find module './names'` and `Cannot find module './bundle'`.

- [x] **Step 4: Implement `types.ts`, `slugify`, `contentDisposition` and `loadBundle`**

`slugify`: NFKD, strip `\p{M}`, lowercase, replace each run of characters outside `[a-z0-9]` with `-`, trim `-`, cut to 80 characters and trim a trailing `-`; an empty result becomes `meeting`. `contentDisposition`: the `filename` fallback replaces non-ASCII characters, `"` and `\` with `_`; `filename*` is `encodeURIComponent` with `'`, `(`, `)` and `*` also percent-encoded. `loadBundle`: the summary is the `.md` file in `out/` other than the three fixed names (newest modification time if several, `ExportError('not_ready', 'This meeting has no summary yet.')` if none); slide files are `slides/` entries matching `^\d{2,3}\.webp$`, sorted by name; everything is read into memory at load, so later deletion of the directory can't corrupt a running export.

- [x] **Step 5: Run them to see them pass**

Run: `bun test packages/exports`
Expected: PASS (`0 fail`).

- [x] **Step 6: Commit**

```bash
git add packages/exports
git commit -m "feat(exports): add bundle loader and types"
```

### Task 2: Document model

**Files:**

- Create: `packages/exports/src/render/doc.ts`
- Test: `packages/exports/src/render/doc.test.ts`

**Interfaces:**

- Consumes: `ExportBundle`, `loadBundle`, `fixture` (task 1).
- Produces:

```ts
export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  href?: string
}
export type DocBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'list'; ordered: boolean; items: Run[][] }
  | { kind: 'table'; header: Run[][]; rows: Run[][][] }
  | { kind: 'image'; path: string; alt: string } // bundle-relative, e.g. "slides/01.webp"
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  | { kind: 'break' } // between the files of a bundle
export function parseMarkdown(md: string): DocBlock[]
export function bundleDocument(bundle: ExportBundle): DocBlock[]
```

- [ ] **Step 1: Write the failing test**

```ts
test('drops the contents list and anchor links', () => {
  expect(parseMarkdown('# T\n\nContents:\n\n1.  [A](#a)\n1.  [B](#b)\n\n## A\n\nSee [B](#b).')).toEqual([
    { kind: 'heading', level: 1, runs: [{ text: 'T' }] },
    { kind: 'heading', level: 2, runs: [{ text: 'A' }] },
    { kind: 'paragraph', runs: [{ text: 'See B.' }] }
  ])
})
test('keeps bold speaker labels, web links and images', () => {
  expect(parseMarkdown('**[00:00:05] Lecturer:** Hello')[0]).toEqual({
    kind: 'paragraph',
    runs: [{ text: '[00:00:05] Lecturer:', bold: true }, { text: ' Hello' }]
  })
  expect(parseMarkdown('[form](https://example.com/x)')[0]).toEqual({
    kind: 'paragraph',
    runs: [{ text: 'form', href: 'https://example.com/x' }]
  })
  expect(parseMarkdown('![Slide 01: Welcome](slides/01.webp)')[0]).toEqual({
    kind: 'image',
    path: 'slides/01.webp',
    alt: 'Slide 01: Welcome'
  })
})
test('clamps deep headings and parses tables', () => {
  expect(parseMarkdown('#### Deep')[0]).toMatchObject({
    kind: 'heading',
    level: 3
  })
  expect(parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')[0]).toEqual({
    kind: 'table',
    header: [[{ text: 'a' }], [{ text: 'b' }]],
    rows: [[[{ text: '1' }], [{ text: '2' }]]]
  })
})
test('bundle order is summary, transcript, slides, chat', async () => {
  const doc = bundleDocument(await loadBundle(fixture))
  expect(doc[0]).toEqual({
    kind: 'paragraph',
    runs: [{ text: 'Data Mining, Week 3 (Tuesday 20 October 2026, 14:00 to 16:00)' }]
  })
  expect(doc.filter((b) => b.kind === 'break')).toHaveLength(3)
  expect(doc.filter((b) => b.kind === 'image').map((b) => (b as { path: string }).path)).toEqual([
    'slides/01.webp',
    'slides/02.webp'
  ])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/exports/src/render/doc.test.ts`
Expected: FAIL with `Cannot find module './doc'`.

- [ ] **Step 3: Implement `parseMarkdown` and `bundleDocument` in `src/render/doc.ts`**

Walk `marked.lexer(md)` tokens. Rules: heading depth above 3 becomes 3; a paragraph whose text is `Contents:` and the list right after it are dropped; a paragraph holding only an image becomes an `image` block; links to `#...` become plain runs, `http` and `https` links keep `href`, other schemes become plain runs; nested list items are flattened into their parent list in order; `html` tokens are dropped; a blockquote's paragraphs are emitted as paragraphs; adjacent plain runs are merged. `bundleDocument` concatenates the summary, `transcript.md`, `slides.md` and `chat.md` (those present) with a `break` between files.

- [ ] **Step 4: Run it to see it pass**

Run: `bun test packages/exports/src/render/doc.test.ts`
Expected: PASS (`0 fail`).

- [ ] **Step 5: Commit**

```bash
git add packages/exports/src/render
git commit -m "feat(exports): add markdown document model"
```

### Task 3: Markdown zip download

**Files:**

- Create: `packages/exports/src/targets/download.ts`, `packages/exports/src/targets/zip.ts`, `packages/exports/test/context.ts`
- Test: `packages/exports/src/targets/zip.test.ts`

**Interfaces:**

- Consumes: `ExportBundle`, `ExportContext`, `ExportTarget`, `ExportError`, `loadBundle`, `fixture` (task 1).
- Produces: `writeDownload(ctx: ExportContext, ext: 'zip' | 'pdf', bytes: Uint8Array): Promise<string>`; `zipBundle(bundle: ExportBundle): Uint8Array`; `zipTarget: ExportTarget` (id `'zip'`); test helper `testContext(over?: Partial<ExportContext>): ExportContext & { sleeps: number[]; saved: Connection[] }` (fresh temporary occurrence directory with `outDir` inside it, `http` that throws `no network in tests`, `sleep` that records and resolves at once, `saveConnection` that records).

- [ ] **Step 1: Write the failing test**

```ts
test('zip holds the set under one folder', async () => {
  const entries = unzipSync(zipBundle(await loadBundle(fixture)))
  expect(Object.keys(entries)).toEqual([
    '2026-10-20-1400-data-mining/2026-10-20 1400 Data Mining.md',
    '2026-10-20-1400-data-mining/transcript.md',
    '2026-10-20-1400-data-mining/slides.md',
    '2026-10-20-1400-data-mining/chat.md',
    '2026-10-20-1400-data-mining/slides/01.webp',
    '2026-10-20-1400-data-mining/slides/02.webp'
  ])
  expect(entries['2026-10-20-1400-data-mining/slides/01.webp']).toEqual(
    new Uint8Array(await readFile(join(fixture, 'slides/01.webp')))
  )
})
test('zipTarget writes <exportId>.zip in outDir', async () => {
  const ctx = testContext({ exportId: 'exp-1' })
  const r = await zipTarget.run(await loadBundle(fixture), ctx)
  expect(r).toEqual({
    url: null,
    filePath: join(ctx.outDir, 'exp-1.zip'),
    note: null
  })
  expect((await stat(r.filePath!)).size).toBeGreaterThan(0)
})
test('a deleted meeting directory is never recreated', async () => {
  const ctx = testContext()
  await rm(dirname(ctx.outDir), { recursive: true })
  await expect(writeDownload(ctx, 'zip', new Uint8Array([1]))).rejects.toMatchObject({ code: 'meeting_deleted' })
  expect(existsSync(dirname(ctx.outDir))).toBe(false)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/exports/src/targets/zip.test.ts`
Expected: FAIL with `Cannot find module './zip'`.

- [ ] **Step 3: Implement `writeDownload`, `zipBundle` and `zipTarget`**

`writeDownload` throws `ExportError('meeting_deleted', 'This meeting has been deleted from TolongMeeting.')` when `dirname(ctx.outDir)` doesn't exist, creates `outDir` without `recursive`, ignoring `EEXIST`, and writes `<exportId>.<ext>`. `zipBundle` uses fflate `zipSync`, level 0 for `.webp` entries (already compressed) and level 6 for the rest, paths `<dirName>/<file path>` in bundle order.

- [ ] **Step 4: Run it to see it pass**

Run: `bun test packages/exports/src/targets/zip.test.ts`
Expected: PASS (`0 fail`).

- [ ] **Step 5: Commit**

```bash
git add packages/exports/src/targets packages/exports/test/context.ts
git commit -m "feat(exports): add markdown zip download"
```

### Task 4: PDF download

**Files:**

- Create: `packages/exports/assets/fonts/` (the four DejaVu Sans TTF files and their `LICENSE`), `packages/exports/src/render/images.ts`, `packages/exports/src/targets/pdf.ts`
- Test: `packages/exports/src/render/images.test.ts`, `packages/exports/src/targets/pdf.test.ts`

**Interfaces:**

- Consumes: `loadBundle`, `fixture` (task 1); `bundleDocument`, `DocBlock` (task 2); `writeDownload`, `testContext` (task 3).
- Produces: `interface Jpeg { bytes: Uint8Array; width: number; height: number }`; `toJpeg(image: Uint8Array, maxWidth?: number): Promise<Jpeg>` (default 1600); `bundleImages(bundle: ExportBundle): Promise<Map<string, Jpeg>>` keyed by bundle path; `renderPdf(doc: DocBlock[], images: Map<string, Jpeg>, title: string): Promise<Uint8Array>`; `pdfTarget: ExportTarget` (id `'pdf'`).

- [ ] **Step 1: Write the failing tests**

```ts
// images.test.ts
test('toJpeg keeps small images and shrinks large ones', async () => {
  const small = await toJpeg(new Uint8Array(await readFile(join(fixture, 'slides/01.webp'))))
  expect([small.bytes[0], small.bytes[1], small.width, small.height]).toEqual([0xff, 0xd8, 64, 36])
  const big = await sharp({
    create: { width: 3200, height: 1800, channels: 3, background: '#fff' }
  })
    .webp()
    .toBuffer()
  expect(await toJpeg(big)).toMatchObject({ width: 1600, height: 900 })
})

// pdf.test.ts
test('the PDF holds every section, slides and symbols', async () => {
  const b = await loadBundle(fixture)
  const pdf = await renderPdf(bundleDocument(b), await bundleImages(b), b.title)
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
  const { totalPages, text } = await extractText(await getDocumentProxy(pdf), {
    mergePages: true
  })
  expect(totalPages).toBeGreaterThanOrEqual(4)
  for (const s of ['Do next: Submit lab 2', '✓', 'Slide 01: Welcome', 'Good afternoon, everyone.', 'see you next week'])
    expect(text).toContain(s)
})
test('pdfTarget writes <exportId>.pdf', async () => {
  const ctx = testContext({ exportId: 'exp-2' })
  expect((await pdfTarget.run(await loadBundle(fixture), ctx)).filePath).toBe(join(ctx.outDir, 'exp-2.pdf'))
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/exports/src/render/images.test.ts packages/exports/src/targets/pdf.test.ts`
Expected: FAIL with `Cannot find module './images'` and `Cannot find module './pdf'`.

- [ ] **Step 3: Implement `toJpeg`, `bundleImages`, `renderPdf` and `pdfTarget`**

`toJpeg`: sharp, resize to `maxWidth` without enlarging, JPEG quality 85. `renderPdf`: pdfmake on the server with DejaVu Sans from `assets/fonts` (it covers `✓`; glyphs it lacks, such as emoji and CJK, print as blanks without failing); A4, 40 pt margins, body 10 pt with line height 1.3, headings bold at 18, 14 and 12 pt, images scaled to fit 515 pt wide, tables with a bold header row, a `break` puts a page break before the next block, `info.title` is `title`. `pdfTarget` renders `bundleDocument` with `bundleImages` and calls `writeDownload(ctx, 'pdf', bytes)`.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test packages/exports/src/render/images.test.ts packages/exports/src/targets/pdf.test.ts`
Expected: PASS (`0 fail`).

- [ ] **Step 5: Commit**

```bash
git add packages/exports/assets packages/exports/src/render/images.ts packages/exports/src/render/images.test.ts packages/exports/src/targets/pdf.ts packages/exports/src/targets/pdf.test.ts
git commit -m "feat(exports): add pdf download"
```

### Task 5: Token vault and stores

**Files:**

- Create: `packages/exports/src/vault.ts`, `packages/exports/src/store.ts`, `packages/web/db/exports-schema.ts`, the generated migration in 01c's migrations folder under `packages/web/db/`
- Modify: `packages/web/db/index.ts` (re-export the new tables; if 01c already declares `connections`, move it into `exports-schema.ts` with the columns below, since nothing before this milestone reads it)
- Test: `packages/exports/src/vault.test.ts`, `packages/exports/src/store.test.ts`

**Interfaces:**

- Consumes: `db`, `Db`, `members`, `occurrences` from `packages/web/db/index.ts` (01c); `TM_MASTER_KEY_FILE`, `TM_DATA_ROOT`; types from task 1.
- Produces (adds to contracts):

```ts
// vault.ts
export function readMasterKey(file: string): Buffer // 32 bytes from base64, else throws
export function sealSecret(plain: string, memberId: string, kind: ConnectionKind, masterKey: Buffer): string
export function openSecret(sealed: string, memberId: string, kind: ConnectionKind, masterKey: Buffer): string
export function redact(text: string, secrets: string[]): string

// store.ts
export interface ExportRow {
  id: string
  occurrenceId: string
  memberId: string
  target: ExportTargetId
  status: ExportStatus
  title: string | null
  url: string | null
  filePath: string | null
  note: string | null
  errorCode: ExportErrorCode | null
  error: string | null
  createdAt: Date
  finishedAt: Date | null
}
export interface ExportStore {
  create(memberId: string, occurrenceId: string, target: ExportTargetId): Promise<ExportRow> // throws ExportError('already_running')
  claimNext(): Promise<ExportRow | null> // oldest queued -> running
  succeed(id: string, title: string, r: ExportResult): Promise<void>
  fail(id: string, code: ExportErrorCode, message: string): Promise<void>
  failInterrupted(): Promise<ExportRow[]> // running -> failed 'interrupted'; returns them
  get(memberId: string, id: string): Promise<ExportRow | null>
  listForOccurrence(memberId: string, occurrenceId: string): Promise<ExportRow[]> // newest first
  purgeDeleted(): Promise<number> // rows whose occurrence is in state 'deleted'
}
export interface ConnectionStore {
  get(
    memberId: string,
    kind: ConnectionKind
  ): Promise<{
    connection: Connection
    status: 'ok' | 'reconnect_needed'
  } | null>
  summaries(memberId: string): Promise<ConnectionSummary[]>
  save(memberId: string, c: Connection): Promise<void> // upsert; status back to 'ok'
  markReconnect(memberId: string, kind: ConnectionKind): Promise<void>
  remove(memberId: string, kind: ConnectionKind): Promise<void>
}
export function createStores(
  db: Db,
  masterKey: Buffer,
  dataRoot: string
): {
  exports: ExportStore
  connections: ConnectionStore
  occurrences: OccurrenceLookup
}
```

Schema (`exports-schema.ts`, Drizzle; id types follow 01c's `members.id` and `occurrences.id`):

```text
connections  id uuid pk default gen_random_uuid()
             member_id   -> members.id on delete cascade, not null
             kind        text not null, check in ('github','google','notion')
             secret      text not null        sealSecret(JSON of the token fields)
             settings    jsonb not null       every non-secret field
             status      text not null default 'ok', check in ('ok','reconnect_needed')
             updated_at  timestamptz not null default now()
             unique (member_id, kind)
exports      id uuid pk default gen_random_uuid()
             occurrence_id -> occurrences.id on delete cascade, not null
             member_id     -> members.id on delete cascade, not null
             target text not null; status text not null default 'queued'
             title, url, file_path, note, error_code, error   text null
             created_at timestamptz not null default now(); started_at, finished_at timestamptz null
             index (status, created_at)
             unique index exports_one_active on (occurrence_id, target) where status in ('queued','running')
```

- [ ] **Step 1: Write the failing tests**

```ts
// vault.test.ts
const key = randomBytes(32)
test('seals per member and kind', () => {
  const s = sealSecret('github_pat_TESTTOKEN123', 'm1', 'github', key)
  expect(s.startsWith('v1.')).toBe(true)
  expect(s).not.toContain('TESTTOKEN')
  expect(openSecret(s, 'm1', 'github', key)).toBe('github_pat_TESTTOKEN123')
  expect(() => openSecret(s, 'm2', 'github', key)).toThrow()
  expect(() => openSecret(s, 'm1', 'notion', key)).toThrow()
  expect(() => openSecret(s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA'), 'm1', 'github', key)).toThrow()
})
test('readMasterKey wants 32 bytes', async () => {
  const f = join(await mkdtemp(join(tmpdir(), 'k')), 'key')
  await writeFile(f, randomBytes(16).toString('base64'))
  expect(() => readMasterKey(f)).toThrow('TM_MASTER_KEY_FILE must hold 32 bytes in base64')
})
test('redact', () => {
  expect(redact('bad token github_pat_abc123 and ya29.a0Bx-y', [])).toBe('bad token [redacted] and [redacted]')
  expect(redact('refresh 1//0gAbC-d failed', [])).toBe('refresh [redacted] failed')
  expect(redact('key s3cretvalue!', ['s3cretvalue!'])).toBe('key [redacted]')
})

// store.test.ts: Postgres. Seed with 01c's test fixtures members m1, m2 and occurrences
// o1 (m1, 'completed') and o2 (m1, 'deleted'); s = createStores(db, randomBytes(32), '/data');
// each test starts with empty exports and connections tables.
test('one active export per occurrence and target', async () => {
  const a = await s.exports.create(m1, o1, 'zip')
  await expect(s.exports.create(m1, o1, 'zip')).rejects.toMatchObject({
    code: 'already_running'
  })
  await s.exports.create(m1, o1, 'pdf')
  await s.exports.succeed(a.id, '2026-10-20 1400 Data Mining', {
    url: null,
    filePath: '/x.zip',
    note: null
  })
  expect((await s.exports.create(m1, o1, 'zip')).status).toBe('queued')
})
test('claimNext takes the oldest queued', async () => {
  const a = await s.exports.create(m1, o1, 'zip')
  await s.exports.create(m1, o1, 'pdf')
  expect(await s.exports.claimNext()).toMatchObject({
    id: a.id,
    status: 'running'
  })
})
test('members see only their own rows', async () => {
  const a = await s.exports.create(m1, o1, 'zip')
  expect(await s.exports.get(m2, a.id)).toBeNull()
  expect(await s.exports.listForOccurrence(m2, o1)).toEqual([])
  expect(await s.occurrences.get(m2, o1)).toBeNull()
  expect(await s.occurrences.get(m1, o1)).toMatchObject({
    state: 'completed',
    dataDir: `/data/occurrences/${o1}`
  })
})
test('secrets are sealed and summaries hold none', async () => {
  await s.connections.save(m1, {
    kind: 'github',
    token: 'github_pat_TESTTOKEN123',
    owner: 'acme',
    repo: 'notes',
    branch: 'main',
    folder: 'meetings'
  })
  expect(JSON.stringify(await db.execute(sql`select * from connections`))).not.toContain('TESTTOKEN')
  expect((await s.connections.get(m1, 'github'))?.connection).toMatchObject({
    token: 'github_pat_TESTTOKEN123'
  })
  expect(await s.connections.summaries(m1)).toEqual([
    {
      kind: 'github',
      status: 'ok',
      ready: true,
      label: 'acme/notes',
      detail: 'branch main, folder meetings'
    }
  ])
})
test('failInterrupted and purgeDeleted', async () => {
  await s.exports.create(m1, o1, 'zip')
  await s.exports.claimNext()
  expect((await s.exports.failInterrupted())[0]).toMatchObject({
    status: 'failed',
    errorCode: 'interrupted',
    error: 'The export was interrupted. Try again.'
  })
  await s.exports.create(m1, o2, 'zip')
  expect(await s.exports.purgeDeleted()).toBe(1)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/exports/src/vault.test.ts packages/exports/src/store.test.ts` (with `DATABASE_URL` pointing at the test database 01c's database tests use)
Expected: FAIL with `Cannot find module './vault'` and `Cannot find module './store'`.

- [ ] **Step 3: Implement the vault, the schema and migration, and the stores**

Vault: key = `hkdfSync('sha256', masterKey, Buffer.alloc(0), 'tm:connection:' + memberId + ':' + kind, 32)`; AES-256-GCM with a random 12-byte IV; output `v1.<base64url iv>.<base64url ciphertext and 16-byte tag>`. `redact` replaces each listed secret of 8 or more characters, then every match of `/github_pat_\w+|gh[opsu]_\w+|ya29\.[\w.-]+|1\/\/[\w-]+|ntn_\w+|secret_\w+/g`, with `[redacted]`. Generate the migration with 01c's drizzle-kit command (`bunx drizzle-kit generate`); the partial index uses Drizzle's `uniqueIndex(...).on(...).where(sql\`status in ('queued','running')\`)`. In `store.ts`, `create`maps the unique-index violation to`ExportError('already_running', 'This export is already running.')`; `claimNext`uses`for update skip locked`; the token fields (`token`; `refreshToken`; `accessToken`and`refreshToken`) are sealed as one JSON string and everything else goes in `settings`. Summaries: GitHub label `<owner>/<repo>`, detail `branch <branch>, folder <folder or />`; Google label `account`, detail `folderName`; Notion label `workspace`, detail `parent.name`or`No page chosen yet`, `ready`false while`parent`is null.`occurrences.get`joins 01c's occurrence to its owning member and sets`dataDir`to`<dataRoot>/occurrences/<id>`.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test packages/exports/src/vault.test.ts packages/exports/src/store.test.ts`
Expected: PASS (`0 fail`).

- [ ] **Step 5: Commit**

```bash
git add packages/exports/src/vault.ts packages/exports/src/vault.test.ts packages/exports/src/store.ts packages/exports/src/store.test.ts packages/web/db
git commit -m "feat(exports): add token vault and stores"
```

### Task 6: Export runner and the tm-exports process

**Files:**

- Create: `packages/exports/src/registry.ts`, `packages/exports/src/runner.ts`, `packages/exports/src/main.ts`, `packages/exports/test/memory-stores.ts`
- Modify: `docker/compose.yaml` (service `exports`; environment for `web`), `.env.example`, root `package.json` (script `tm-exports`)
- Test: `packages/exports/src/runner.test.ts`, `packages/exports/src/registry.test.ts`

**Interfaces:**

- Consumes: `sendPing`, `Ping`, `NtfyConfig` (`packages/notify`); `memberNtfyConfig` and `db` (01c, see [contract additions](#contract-additions)); `loadBundle` (task 1); `zipTarget` (task 3); `pdfTarget` (task 4); `createStores`, `readMasterKey`, `redact`, `ExportRow`, `ExportStore`, `ConnectionStore` (task 5).
- Produces:

```ts
// registry.ts
export function oauthClientFromEnv(
  kind: 'google' | 'notion',
  env?: Record<string, string | undefined>
): OAuthClient | null
// GOOGLE_CLIENT_ID/SECRET or NOTION_CLIENT_ID/SECRET; redirectUri `${TM_PUBLIC_URL}/api/connections/<kind>/callback`; null if either is unset
export function buildTargets(clients: {
  google: OAuthClient | null
  notion: OAuthClient | null
}): Partial<Record<ExportTargetId, ExportTarget>>
// runner.ts
export interface RunnerDeps {
  exports: ExportStore
  connections: ConnectionStore
  occurrences: OccurrenceLookup
  targets: Partial<Record<ExportTargetId, ExportTarget>>
  ping(memberId: string, p: Ping): Promise<void>
  publicUrl: string
  http: typeof fetch
  sleep(ms: number): Promise<void>
  log(line: string): void
}
export async function runExport(row: ExportRow, deps: RunnerDeps): Promise<void>
export async function runLoop(deps: RunnerDeps, signal: AbortSignal, pollMs?: number): Promise<void> // default 2000
export function exportPing(
  row: ExportRow,
  title: string | null,
  outcome: { ok: true; result: ExportResult } | { ok: false; code: ExportErrorCode; message: string },
  publicUrl: string
): Ping
// test/memory-stores.ts
export function memoryStores(seed?: {
  occurrences?: OccurrenceInfo[]
  connections?: {
    memberId: string
    connection: Connection
    status?: 'ok' | 'reconnect_needed'
  }[]
}): {
  exports: ExportStore
  connections: ConnectionStore
  occurrences: OccurrenceLookup
  markedReconnect: ConnectionKind[]
}
```

Ping copy (priority `'default'` for all; `<meeting page>` is `<TM_PUBLIC_URL>/meetings/<occurrenceId>`):

```text
Success, zip or PDF   title: Export finished
                      message: "<title>" is ready to download.
                      actions: Open meeting page -> <meeting page>
Success, remote       title: Export finished
                      message: "<title>" is in <label>.   (when note is set: "<title>" was already up to date in <label>.)
                      actions: Open -> <result url>; Open meeting page -> <meeting page>
Failure               title: Export failed
                      message: "<title, or This meeting>" to <label>: <ExportError message>
                      actions: Reconnect -> <TM_PUBLIC_URL>/connections (codes not_connected, reconnect_needed, invalid_settings, not_found on GitHub, Google Docs or Notion); Open meeting page -> <meeting page>
```

- [ ] **Step 1: Write the failing tests**

```ts
// registry.test.ts
test('downloads are always there; remote targets need their client', () => {
  expect(Object.keys(buildTargets({ google: null, notion: null })).sort()).toEqual(['pdf', 'zip'])
  expect(
    oauthClientFromEnv('google', {
      TM_PUBLIC_URL: 'https://tm.example',
      GOOGLE_CLIENT_ID: 'a',
      GOOGLE_CLIENT_SECRET: 'b'
    })
  ).toEqual({
    clientId: 'a',
    clientSecret: 'b',
    redirectUri: 'https://tm.example/api/connections/google/callback'
  })
  expect(
    oauthClientFromEnv('notion', {
      TM_PUBLIC_URL: 'https://tm.example',
      NOTION_CLIENT_ID: 'a'
    })
  ).toBeNull()
})

// runner.test.ts: the occurrence o1 (member m1, 'completed') has dataDir = a copy of the task 1 fixture
test('zip success records the file and pings', async () => {
  const { deps, pings, stores } = setup() // memoryStores + targets { zip: zipTarget }
  const row = await stores.exports.create('m1', 'o1', 'zip')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    status: 'succeeded',
    title: '2026-10-20 1400 Data Mining'
  })
  expect(pings[0]).toEqual({
    title: 'Export finished',
    message: '"2026-10-20 1400 Data Mining" is ready to download.',
    priority: 'default',
    actions: [{ label: 'Open meeting page', url: 'https://tm.example/meetings/o1' }]
  })
})
test('a remote target without a connection fails and offers Reconnect', async () => {
  const { deps, pings, stores } = setup({
    targets: { github: fakeTarget('github') }
  })
  const row = await stores.exports.create('m1', 'o1', 'github')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    status: 'failed',
    errorCode: 'not_connected',
    error: 'Connect GitHub on the Connections page first.'
  })
  expect(pings[0].actions?.[0]).toEqual({
    label: 'Reconnect',
    url: 'https://tm.example/connections'
  })
})
test('reconnect_needed is redacted, flags the connection and never logs the token', async () => {
  const lines: string[] = []
  const { deps, stores } = setup({
    log: (l) => lines.push(l),
    connections: [githubConn('github_pat_abc123')],
    targets: {
      github: fakeTarget('github', new ExportError('reconnect_needed', 'GitHub rejected github_pat_abc123'))
    }
  })
  const row = await stores.exports.create('m1', 'o1', 'github')
  await runExport(row, deps)
  expect((await stores.exports.get('m1', row.id))?.error).toBe('GitHub rejected [redacted]')
  expect(stores.markedReconnect).toEqual(['github'])
  expect(lines.join('\n')).not.toContain('github_pat_')
})
test('deleted, unfinished and broken meetings', async () => {
  for (const [state, code, error] of [
    ['deleted', 'meeting_deleted', 'This meeting has been deleted from TolongMeeting.'],
    ['transcribing', 'not_ready', 'This meeting is still being processed.']
  ] as const) {
    const { deps, stores, ran } = setup({ state })
    const row = await stores.exports.create('m1', 'o1', 'zip')
    await runExport(row, deps)
    expect(await stores.exports.get('m1', row.id)).toMatchObject({
      errorCode: code,
      error
    })
    expect(ran()).toBe(0)
  }
  const { deps, stores } = setup({
    targets: { zip: fakeTarget('zip', new Error('boom')) }
  })
  const row = await stores.exports.create('m1', 'o1', 'zip')
  await runExport(row, deps)
  expect((await stores.exports.get('m1', row.id))?.error).toBe('Something went wrong: boom. Try again.')
})
test('runLoop fails interrupted rows, then runs queued ones in order', async () => {
  const { deps, stores, pings } = setup()
  const stale = await stores.exports.create('m1', 'o1', 'pdf')
  await stores.exports.claimNext()
  await stores.exports.create('m1', 'o1', 'zip')
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  await runLoop(deps, ac.signal, 5)
  expect(await stores.exports.get('m1', stale.id)).toMatchObject({
    errorCode: 'interrupted'
  })
  expect(pings.map((p) => p.title)).toEqual(['Export failed', 'Export finished'])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/exports/src/registry.test.ts packages/exports/src/runner.test.ts`
Expected: FAIL with `Cannot find module './registry'` and `Cannot find module './runner'`.

- [ ] **Step 3: Implement the registry, the runner, `main.ts` and the memory stores**

`runExport` in order:

1.  Look up the occurrence for `row.memberId`; missing or `deleted` fails with `meeting_deleted`, any state other than `completed` fails with `not_ready` (messages as in the test).
1.  A target missing from `deps.targets` fails with `failed`, "This export isn't available yet.".
1.  If `TARGET_CONNECTION[target]` is set: no connection fails with `not_connected`, "Connect <label> on the Connections page first."; status `reconnect_needed` fails with the same code and "<label> needs you to connect again on the Connections page." without calling the target.
1.  `loadBundle(dataDir)`, then `target.run(bundle, ctx)` with `outDir = join(dataDir, 'exports')` and `saveConnection = (c) => connections.save(memberId, c)`.
1.  Success: `exports.succeed(id, bundle.title, result)`. `ExportError`: `exports.fail(code, redact(message, tokens))`, plus `connections.markReconnect` for `reconnect_needed`. Any other error: `failed`, "Something went wrong: <redacted message>. Try again.".
1.  Ping with `exportPing`, then log one line `export <id> <target> <status> [<code>]`; a failing ping is logged and doesn't change the row.

`runLoop`: `failInterrupted()` and ping each returned row; `purgeDeleted()` at start and every 3,600,000 ms; then `claimNext()` and `runExport` one at a time, sleeping `pollMs` when idle, until `signal` aborts (an export in progress finishes first). `main.ts` wires `createStores(db, readMasterKey(TM_MASTER_KEY_FILE), TM_DATA_ROOT)`, `buildTargets({ google: oauthClientFromEnv('google'), notion: oauthClientFromEnv('notion') })`, `ping = async (m, p) => sendPing(await memberNtfyConfig(m), p)`, `fetch`, `Bun.sleep` and `console.log`, and aborts on `SIGTERM` and `SIGINT`.

Compose service, using the same image, data volume, master-key secret and network as 01c's `pipeline` service:

```yaml
exports:
  command: ['bun', 'run', 'packages/exports/src/main.ts']
  environment:
    DATABASE_URL: ${DATABASE_URL}
    TM_PUBLIC_URL: ${TM_PUBLIC_URL}
    # TM_DATA_ROOT and TM_MASTER_KEY_FILE: the same values as the pipeline service
    GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
    GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
    NOTION_CLIENT_ID: ${NOTION_CLIENT_ID}
    NOTION_CLIENT_SECRET: ${NOTION_CLIENT_SECRET}
  restart: unless-stopped
```

The `web` service gains the same four OAuth variables plus `GOOGLE_API_KEY` and `GOOGLE_APP_ID`; `.env.example` lists all six names without values; the root script is `"tm-exports": "bun run packages/exports/src/main.ts"`.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test packages/exports/src/registry.test.ts packages/exports/src/runner.test.ts && docker compose -f docker/compose.yaml config --services`
Expected: PASS (`0 fail`), and the service list includes `exports`.

- [ ] **Step 5: Commit**

```bash
git add packages/exports docker/compose.yaml .env.example package.json
git commit -m "feat(exports): add export runner service"
```

### Task 7: Export API and meeting-page panel

**Files:**

- Create: `packages/exports/src/api.ts`, `packages/web/lib/exports.ts`, `packages/web/app/api/meetings/[occurrenceId]/exports/route.ts`, `packages/web/app/api/exports/[exportId]/file/route.ts`, `packages/web/app/api/connections/route.ts`, `packages/web/components/export-panel.tsx`
- Modify: `packages/web/package.json` (depend on the exports workspace package), the 01c meeting page `packages/web/app/meetings/[occurrenceId]/page.tsx` (render `<ExportPanel occurrenceId={...} />` where the design puts the export buttons)
- Test: `packages/exports/src/api.test.ts`

**Interfaces:**

- Consumes: `requireMember` and `db` (01c); `createStores`, `readMasterKey` (task 5); `memoryStores` (task 6); `contentDisposition` (task 1).
- Produces:

```ts
export interface ApiDeps {
  exports: ExportStore
  connections: ConnectionStore
  occurrences: OccurrenceLookup
}
export interface ApiResult {
  status: number
  body: unknown
}
export interface ExportView {
  id: string
  target: ExportTargetId
  label: string
  status: ExportStatus
  createdAt: string
  finishedAt: string | null
  url: string | null
  downloadUrl: string | null
  note: string | null
  error: string | null
}
export async function createExportRequest(
  memberId: string,
  occurrenceId: string,
  body: unknown,
  deps: ApiDeps
): Promise<ApiResult>
export async function listExportsRequest(memberId: string, occurrenceId: string, deps: ApiDeps): Promise<ApiResult> // { exports: ExportView[] }
export async function exportFileRequest(memberId: string, exportId: string, deps: ApiDeps): Promise<Response>
export async function connectionsRequest(memberId: string, deps: ApiDeps): Promise<ApiResult> // { connections: ConnectionSummary[] }
export function buttonState(
  target: ExportTargetId,
  connections: ConnectionSummary[],
  rows: ExportView[]
): { enabled: boolean; hint: string | null }
// packages/web/lib/exports.ts
export function exportDeps(): ApiDeps // createStores(db, readMasterKey(TM_MASTER_KEY_FILE), TM_DATA_ROOT), built once
```

Routes: `GET` and `POST /api/meetings/[occurrenceId]/exports` (body `{ target }`), `GET /api/exports/[exportId]/file`, `GET /api/connections`. Each handler calls `requireMember(req)`, then the matching function, and returns `Response.json(body, { status })` (the file route returns the `Response` as it is).

- [ ] **Step 1: Write the failing test**

```ts
test('creating exports', async () => {
  const deps = memoryStores({
    occurrences: [occ('o1', 'm1', 'completed'), occ('o2', 'm1', 'deleted'), occ('o3', 'm1', 'post_processing')]
  })
  expect(await createExportRequest('m1', 'o1', { target: 'zip' }, deps)).toMatchObject({
    status: 202,
    body: { exportId: expect.any(String) }
  })
  expect(await createExportRequest('m1', 'o1', { target: 'zip' }, deps)).toEqual({
    status: 409,
    body: {
      error: 'already_running',
      message: 'This export is already running.'
    }
  })
  expect(await createExportRequest('m2', 'o1', { target: 'pdf' }, deps)).toEqual({
    status: 404,
    body: { error: 'not_found' }
  })
  expect(await createExportRequest('m1', 'o1', { target: 'dropbox' }, deps)).toEqual({
    status: 400,
    body: { error: 'invalid_target' }
  })
  expect(await createExportRequest('m1', 'o2', { target: 'pdf' }, deps)).toMatchObject({
    status: 410,
    body: { error: 'meeting_deleted' }
  })
  expect(await createExportRequest('m1', 'o3', { target: 'pdf' }, deps)).toMatchObject({
    status: 409,
    body: { error: 'not_ready' }
  })
  expect(await createExportRequest('m1', 'o1', { target: 'github' }, deps)).toEqual({
    status: 400,
    body: {
      error: 'not_connected',
      message: 'Connect GitHub on the Connections page first.'
    }
  })
})
test('a Notion connection without a parent is not ready', async () => {
  const deps = memoryStores({
    occurrences: [occ('o1', 'm1', 'completed')],
    connections: [
      {
        memberId: 'm1',
        connection: {
          kind: 'notion',
          accessToken: 'ntn_x',
          refreshToken: null,
          workspace: 'Notes',
          parent: null
        }
      }
    ]
  })
  expect(await createExportRequest('m1', 'o1', { target: 'notion' }, deps)).toEqual({
    status: 400,
    body: {
      error: 'invalid_settings',
      message: 'Pick a Notion page or database for exports on the Connections page.'
    }
  })
})
test('lists hide server paths; files go only to their owner', async () => {
  const deps = await withFinishedZip('m1', 'o1') // succeeded zip row, file on disk, title '2026-10-20 1400 Pengurusan Café'
  const { body } = await listExportsRequest('m1', 'o1', deps)
  expect(JSON.stringify(body)).not.toContain('filePath')
  expect((body as { exports: ExportView[] }).exports[0].downloadUrl).toBe(`/api/exports/${deps.zipId}/file`)
  const res = await exportFileRequest('m1', deps.zipId, deps)
  expect(res.headers.get('content-type')).toBe('application/zip')
  expect(res.headers.get('content-disposition')).toBe(contentDisposition('2026-10-20 1400 Pengurusan Café.zip'))
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect((await exportFileRequest('m2', deps.zipId, deps)).status).toBe(404)
  expect((await listExportsRequest('m2', 'o1', deps)).status).toBe(404)
})
test('connections list carries no secrets', async () => {
  const deps = memoryStores({
    connections: [{ memberId: 'm1', connection: githubConn('github_pat_abc123') }]
  })
  expect(JSON.stringify(await connectionsRequest('m1', deps))).not.toContain('github_pat_')
  expect(await connectionsRequest('m2', deps)).toEqual({
    status: 200,
    body: { connections: [] }
  })
})
test('buttonState', () => {
  expect(buttonState('zip', [], [])).toEqual({ enabled: true, hint: null })
  expect(buttonState('github', [], [])).toEqual({
    enabled: false,
    hint: 'Connect GitHub on the Connections page'
  })
  expect(buttonState('gdocs', [summary('google', 'reconnect_needed')], [])).toEqual({
    enabled: false,
    hint: 'Reconnect Google Docs on the Connections page'
  })
  expect(buttonState('pdf', [], [view('pdf', 'running')])).toEqual({
    enabled: false,
    hint: 'Exporting'
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/exports/src/api.test.ts`
Expected: FAIL with `Cannot find module './api'`.

- [ ] **Step 3: Implement `api.ts`, the route handlers, `exportDeps` and `ExportPanel`**

Check order in `createExportRequest`: zod body (`invalid_target`, 400), ownership (404), `deleted` (410, "This meeting has been deleted from TolongMeeting."), not `completed` (409, "This meeting is still being processed."), connection (400 `not_connected`, `reconnect_needed` or `invalid_settings`, with the runner's messages), then `exports.create` (409 on `already_running`), 202 `{ exportId }`. `buttonState`: any target is disabled with hint `Exporting` while an export to it is `queued` or `running`; otherwise downloads are enabled, and remote targets are disabled with the hints in the test while not connected or needing reconnection, and with `Pick a Notion page on the Connections page` while a Notion connection isn't `ready`. `exportFileRequest` answers 404 unless the row is the member's, `succeeded`, `zip` or `pdf`, and its file exists; it streams the file with the headers in the test, named `<title>.zip` or `<title>.pdf`. `ExportPanel` is a client component: it loads `/api/connections` and the export list, polls the list every 2,000 ms while any export is `queued` or `running`, and calls `window.location.assign(downloadUrl)` when a download this page view started succeeds. Copy:

```text
Export
[Download Markdown (.zip)] [Download PDF] [Export to GitHub] [Export to Google Docs] [Export to Notion]
GitHub: exporting again updates the same folder. Google Docs and Notion: each export makes a new copy.
Exports are your own copies. Deleting this meeting, by hand or after 30 days, doesn't touch them.
```

Below the buttons, each export shows its label, status, time, and "Open" (`url`), "Download" (`downloadUrl`), the note or the error.

- [ ] **Step 4: Run it to see it pass**

Run: `bun test packages/exports/src/api.test.ts && bun run typecheck`
Expected: PASS (`0 fail`); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/exports/src/api.ts packages/exports/src/api.test.ts packages/web
git commit -m "feat(web): add export api and meeting panel"
```

### Task 8: GitHub connection and target

**Files:**

- Create: `packages/exports/src/connections/github.ts`, `packages/exports/src/targets/github.ts`, `packages/web/app/api/connections/github/route.ts`, `packages/exports/test/fake-fetch.ts`
- Modify: `packages/exports/src/registry.ts` (add `github`)
- Test: `packages/exports/src/connections/github.test.ts`, `packages/exports/src/targets/github.test.ts`

**Interfaces:**

- Consumes: `ExportTarget`, `GitHubConnection`, `loadBundle`, `fixture` (task 1); `testContext` (task 3); `ConnectionStore` (task 5); `memoryStores` (task 6); `ApiResult` (task 7).
- Produces:

```ts
// connections/github.ts
export function normaliseRepoFolder(input: string): string // throws ExportError('invalid_settings')
export async function saveGitHubConnection(
  memberId: string,
  body: unknown,
  deps: { connections: ConnectionStore; http: typeof fetch }
): Promise<ApiResult>
// targets/github.ts
export function gitBlobSha(bytes: Uint8Array): string
export function commitMessage(verb: 'add' | 'update', title: string): string
export const githubTarget: ExportTarget // id 'github'
// test/fake-fetch.ts
export interface FakeCall {
  method: string
  url: string
  headers: Record<string, string>
  body: string
} // header names lower-case
export function fakeFetch(
  routes: [method: string, url: string | RegExp, respond: (req: Request, n: number) => Response | Promise<Response>][]
): {
  fetch: typeof fetch
  calls: FakeCall[]
  call(method: string, url: string | RegExp): FakeCall // first match; throws if none
  count(method: string, url: string | RegExp): number
}
// A string matches a request whose origin + pathname, or pathname alone, equals it; a RegExp is tested on the full URL.
// `n` counts earlier calls to the same route. An unmatched request throws `unexpected <method> <url>`.
```

Route: `PUT /api/connections/github` with `{ owner, repo, branch, folder, token? }` (the token may be left out to keep the stored one). Every GitHub request sends `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` and `User-Agent: TolongMeeting`.

- [ ] **Step 1: Write the failing tests**

```ts
// connections/github.test.ts
test('normaliseRepoFolder', () => {
  expect(normaliseRepoFolder(' /docs/meetings/ ')).toBe('docs/meetings')
  expect(normaliseRepoFolder('docs\\meetings//2026')).toBe('docs/meetings/2026')
  expect(normaliseRepoFolder('')).toBe('')
  for (const bad of ['docs/../x', '.git/hooks', 'a/.git'])
    expect(() => normaliseRepoFolder(bad)).toThrow('Use a folder path inside the repository, without ".." or ".git".')
})
test('saving checks the token and the repository', async () => {
  const save = (body: object, f = okGitHub()) =>
    saveGitHubConnection('m1', body, {
      connections: memoryStores().connections,
      http: f.fetch
    })
  const base = {
    owner: 'acme',
    repo: 'notes',
    branch: 'main',
    folder: 'meetings'
  }
  expect(await save({ ...base, token: 'ghp_classic' })).toEqual({
    status: 400,
    body: {
      error: 'invalid_settings',
      message: 'Use a fine-grained token (it starts with github_pat_) limited to this repository.'
    }
  })
  expect((await save({ ...base, token: 'github_pat_x' }, gitHub({ repo: 404 }))).body).toMatchObject({
    message: "This token can't see acme/notes. Give it access to that repository."
  })
  expect((await save({ ...base, token: 'github_pat_x' }, gitHub({ branch: 404 }))).body).toMatchObject({
    message: "Branch main doesn't exist in acme/notes."
  })
  expect((await save({ ...base, token: 'github_pat_x' }, gitHub({ repo: 401 }))).body).toMatchObject({
    message: 'GitHub rejected this token.'
  })
  expect((await save({ ...base, token: 'github_pat_x' })).status).toBe(200)
})

// targets/github.test.ts: conn = githubConn('github_pat_test'); base path meetings/2026-10-20-1400-data-mining
test('gitBlobSha and commitMessage', () => {
  expect(gitBlobSha(new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  expect(commitMessage('add', '2026-10-20 1400 Data Mining')).toBe('docs: add 2026-10-20 1400 Data Mining')
  expect(commitMessage('add', '2026-10-20 1400 Advanced Database Systems Lecture 7')).toBe(
    'docs: add 2026-10-20 1400 Advanced Database'
  )
  expect(commitMessage('update', '2026-10-20 1400 Advanced Database Systems Lecture 7').length).toBeLessThanOrEqual(50)
})
test('first export commits the whole set, spaced out', async () => {
  const gh = repoFake({ existing: null }) // contents GET 404; ref, commit, blobs, tree, commit, ref PATCH ok
  const ctx = testContext({ http: gh.fetch, connection: conn })
  const r = await githubTarget.run(await loadBundle(fixture), ctx)
  expect(gh.blobPosts).toBe(2) // the two webp files; Markdown goes inline in the tree
  expect(gh.tree.base_tree).toBe('TREE0')
  expect(gh.tree.tree.map((e: { path: string }) => e.path)).toEqual([
    'meetings/2026-10-20-1400-data-mining/2026-10-20 1400 Data Mining.md',
    'meetings/2026-10-20-1400-data-mining/transcript.md',
    'meetings/2026-10-20-1400-data-mining/slides.md',
    'meetings/2026-10-20-1400-data-mining/chat.md',
    'meetings/2026-10-20-1400-data-mining/slides/01.webp',
    'meetings/2026-10-20-1400-data-mining/slides/02.webp'
  ])
  expect(gh.commit.message).toBe('docs: add 2026-10-20 1400 Data Mining')
  expect(gh.refPatch).toEqual({ sha: 'COMMIT1', force: false })
  expect(r.url).toBe('https://github.com/acme/notes/tree/main/meetings/2026-10-20-1400-data-mining')
  expect(ctx.sleeps).toEqual(Array(gh.writes - 1).fill(800))
})
test('re-export sends only changes and deletes stale slides', async () => {
  const gh = repoFake({
    existing: sameAsFixtureExcept({
      'slides.md': 'old',
      'slides/03.webp': 'old'
    })
  })
  await githubTarget.run(await loadBundle(fixture), testContext({ http: gh.fetch, connection: conn }))
  expect(gh.blobPosts).toBe(0)
  expect(gh.tree.tree).toEqual([
    {
      path: 'meetings/2026-10-20-1400-data-mining/slides.md',
      mode: '100644',
      type: 'blob',
      content: expect.any(String)
    },
    {
      path: 'meetings/2026-10-20-1400-data-mining/slides/03.webp',
      mode: '100644',
      type: 'blob',
      sha: null
    }
  ])
  expect(gh.commit.message).toBe('docs: update 2026-10-20 1400 Data Mining')
})
test('no changes means no commit', async () => {
  const gh = repoFake({ existing: sameAsFixtureExcept({}) })
  expect(
    (await githubTarget.run(await loadBundle(fixture), testContext({ http: gh.fetch, connection: conn }))).note
  ).toBe('No changes since the last export')
  expect(gh.writes).toBe(0)
})
test('a moved branch retries once; a bad token asks to reconnect', async () => {
  expect(
    (
      await githubTarget.run(
        await loadBundle(fixture),
        testContext({
          http: repoFake({ existing: null, refPatch: [422, 200] }).fetch,
          connection: conn
        })
      )
    ).url
  ).toBeTruthy()
  await expect(
    githubTarget.run(
      await loadBundle(fixture),
      testContext({
        http: repoFake({ existing: null, refPatch: [422, 422] }).fetch,
        connection: conn
      })
    )
  ).rejects.toMatchObject({
    code: 'failed',
    message: 'The branch changed during the export. Try again.'
  })
  await expect(
    githubTarget.run(await loadBundle(fixture), testContext({ http: repoFake({ ref: 401 }).fetch, connection: conn }))
  ).rejects.toMatchObject({ code: 'reconnect_needed' })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/exports/src/connections/github.test.ts packages/exports/src/targets/github.test.ts`
Expected: FAIL with `Cannot find module './github'`.

- [ ] **Step 3: Implement the connection, the target and the route; add `github` to `buildTargets`**

`saveGitHubConnection` validates with zod (`owner` and `repo` match `^[A-Za-z0-9_.-]+$`), requires a token starting with `github_pat_` unless one is stored, normalises the folder, then calls `GET /repos/{owner}/{repo}` and `GET /repos/{owner}/{repo}/branches/{branch}` with the messages in the test, and saves. The app can't read a fine-grained token's repository list, so the prefix check and the repository check are the enforcement; the Connections page tells the member to pick "Only select repositories". `commitMessage` is `docs: <verb> <title>`; if that is over 50 characters, the title is cut back to its last whole word that fits (a title without spaces is cut hard). `githubTarget.run`, with base path `<folder>/<dirName>` (or `<dirName>` when the folder is empty) and path segments URL-encoded:

1.  `GET /repos/{o}/{r}/contents/{base}?ref={branch}` and `.../{base}/slides?ref={branch}` list existing files and their blob SHAs (404 means none); verb `update` if the base exists, else `add`.
1.  `GET /repos/{o}/{r}/git/ref/heads/{branch}` for the head commit, then `GET .../git/commits/{sha}` for its tree.
1.  Entries: bundle files missing from the listing or whose `gitBlobSha` differs from it; Markdown inline as `content`, WebP through `POST .../git/blobs` (base64); existing files under the base path that aren't in the bundle get `sha: null`. No entries: return `{ url: <folder URL>, filePath: null, note: 'No changes since the last export' }`.
1.  `POST .../git/trees` with `base_tree`, `POST .../git/commits` with the message and the head as parent, `PATCH .../git/refs/heads/{branch}` with `force: false`; a 422 there restarts from step 2 once, a second 422 throws `failed`, "The branch changed during the export. Try again.".
1.  Every content-creating request (blob, tree, commit and ref writes) except the first is preceded by `ctx.sleep(800)`, keeping under GitHub's 80 per minute.

Errors: 401 throws `reconnect_needed`, "GitHub rejected the token. It may have expired; add a new one on the Connections page."; 403 or 404 on the ref or a write throws `not_found`, "TolongMeeting can't write to <owner>/<repo> on branch <branch> with this token. Check its repository access and Contents permission."; 429, or 403 with a `retry-after` header, throws `rate_limited`, "GitHub is limiting requests. Try again later.".

- [ ] **Step 4: Run them to see them pass**

Run: `bun test packages/exports/src/connections/github.test.ts packages/exports/src/targets/github.test.ts packages/exports/src/registry.test.ts`
Expected: PASS (`0 fail`), with the registry test's expected keys updated to `['github', 'pdf', 'zip']`.

- [ ] **Step 5: Commit**

```bash
git add packages/exports packages/web/app/api/connections/github
git commit -m "feat(exports): add github target"
```

### Task 9: Word renderer

**Files:**

- Create: `packages/exports/src/render/docx.ts`
- Test: `packages/exports/src/render/docx.test.ts`

**Interfaces:**

- Consumes: `loadBundle`, `fixture` (task 1); `DocBlock`, `bundleDocument` (task 2); `Jpeg`, `bundleImages` (task 4).
- Produces: `toDocx(doc: DocBlock[], images: Map<string, Jpeg>, title: string): Promise<Uint8Array>`.

- [ ] **Step 1: Write the failing test**

```ts
test('the Word file holds text, headings, page breaks and images', async () => {
  const b = await loadBundle(fixture)
  const files = unzipSync(await toDocx(bundleDocument(b), await bundleImages(b), b.title))
  const xml = new TextDecoder().decode(files['word/document.xml'])
  expect(xml).toContain('Submit lab 2 (due 27 October 2026, 23:59)')
  expect(xml).toContain('<w:pStyle w:val="Heading1"/>')
  expect(xml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(3)
  expect(Object.keys(files).filter((k) => k.startsWith('word/media/'))).toHaveLength(2)
  expect(new TextDecoder().decode(files['docProps/core.xml'])).toContain('2026-10-20 1400 Data Mining')
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/exports/src/render/docx.test.ts`
Expected: FAIL with `Cannot find module './docx'`.

- [ ] **Step 3: Implement `toDocx` in `src/render/docx.ts`**

The `docx` library: headings to `HeadingLevel.HEADING_1` to `HEADING_3`; runs keep bold, italic, monospace for `code`, and `ExternalHyperlink` for `href`; lists through one numbered and one bulleted numbering config; tables with a bold header row; images as `ImageRun` type `jpg`, scaled to at most 600 px wide; the block after a `break` gets `pageBreakBefore: true`; the document `title` property is `title`.

- [ ] **Step 4: Run it to see it pass**

Run: `bun test packages/exports/src/render/docx.test.ts`
Expected: PASS (`0 fail`).

- [ ] **Step 5: Commit**

```bash
git add packages/exports/src/render/docx.ts packages/exports/src/render/docx.test.ts
git commit -m "feat(exports): add word renderer"
```

### Task 10: Google Docs connection and target

**Files:**

- Create: `packages/exports/src/connections/oauth.ts`, `packages/exports/src/connections/google.ts`, `packages/exports/src/targets/gdocs.ts`, `packages/web/app/api/connections/google/start/route.ts`, `.../google/callback/route.ts`, `.../google/picker/route.ts`, `.../google/folder/route.ts`
- Modify: `packages/exports/src/registry.ts` (add `gdocs` when the Google client is configured)
- Test: `packages/exports/src/connections/oauth.test.ts`, `packages/exports/src/connections/google.test.ts`, `packages/exports/src/targets/gdocs.test.ts`

**Interfaces:**

- Consumes: `OAuthClient`, `GoogleConnection`, `loadBundle`, `fixture` (task 1); `bundleDocument` (task 2); `testContext` (task 3); `bundleImages` (task 4); `ConnectionStore` (task 5); `oauthClientFromEnv`, `memoryStores` (task 6); `ApiResult` (task 7); `fakeFetch` (task 8); `toDocx` (task 9).
- Produces:

```ts
// connections/oauth.ts
export function pkceChallenge(verifier: string): string
export function newOAuthState(): {
  state: string
  verifier: string
  challenge: string
}
export function stateCookie(kind: 'google' | 'notion', state: string, verifier: string): string // Set-Cookie value
export function clearStateCookie(kind: 'google' | 'notion'): string
export function readStateCookie(req: Request, kind: 'google' | 'notion'): { state: string; verifier: string } | null
// connections/google.ts
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DEFAULT_FOLDER_NAME = 'TolongMeeting Exports'
export function googleAuthUrl(o: { client: OAuthClient; state: string; codeChallenge: string }): string
export async function googleAccessToken(refreshToken: string, client: OAuthClient, http: typeof fetch): Promise<string> // invalid_grant -> reconnect_needed
export async function ensureDefaultFolder(
  accessToken: string,
  http: typeof fetch
): Promise<{ id: string; name: string }>
export async function completeGoogleConnect(
  memberId: string,
  url: URL,
  cookie: { state: string; verifier: string } | null,
  deps: {
    connections: ConnectionStore
    http: typeof fetch
    client: OAuthClient
  }
): Promise<ApiResult>
export async function pickerToken(
  memberId: string,
  deps: {
    connections: ConnectionStore
    http: typeof fetch
    client: OAuthClient
    apiKey: string
    appId: string
  }
): Promise<ApiResult> // { accessToken, apiKey, appId }
export async function setGoogleFolder(
  memberId: string,
  body: unknown,
  deps: {
    connections: ConnectionStore
    http: typeof fetch
    client: OAuthClient
  }
): Promise<ApiResult> // { folderId } or { useDefault: true }
// targets/gdocs.ts
export function createGdocsTarget(client: OAuthClient): ExportTarget // id 'gdocs'
```

Routes: `GET /api/connections/google/start` redirects to `googleAuthUrl` and sets the state cookie; `GET .../callback` runs `completeGoogleConnect`, clears the cookie and redirects to `/connections`; `GET .../picker` returns `pickerToken` with `Cache-Control: no-store`; `PUT .../folder` runs `setGoogleFolder`. `GOOGLE_API_KEY` and `GOOGLE_APP_ID` (the Cloud project number) feed the Picker.

- [ ] **Step 1: Write the failing tests**

```ts
// oauth.test.ts
test('PKCE and the state cookie', () => {
  expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  )
  const c = stateCookie('google', 's1', 'v1')
  for (const part of [
    'tm_oauth_google=s1.v1',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/api/connections/google',
    'Max-Age=600'
  ])
    expect(c).toContain(part)
  expect(
    readStateCookie(
      new Request('https://tm.example', {
        headers: { cookie: 'tm_oauth_google=s1.v1' }
      }),
      'google'
    )
  ).toEqual({ state: 's1', verifier: 'v1' })
})

// google.test.ts
const client = {
  clientId: 'cid',
  clientSecret: 'cs',
  redirectUri: 'https://tm.example/api/connections/google/callback'
}
test('asks for drive.file only, offline', () => {
  const u = new URL(googleAuthUrl({ client, state: 's1', codeChallenge: 'c1' }))
  expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
  expect(u.searchParams.get('access_type')).toBe('offline')
  expect(u.searchParams.get('prompt')).toBe('consent')
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  expect(u.searchParams.get('include_granted_scopes')).toBeNull()
})
test('connecting checks state, needs a refresh token and reuses the default folder', async () => {
  const cb = (q: string) => new URL(`https://tm.example/api/connections/google/callback?${q}`)
  const deps = (f: ReturnType<typeof fakeFetch>) => ({
    connections: memoryStores().connections,
    http: f.fetch,
    client
  })
  expect(
    await completeGoogleConnect('m1', cb('code=c&state=WRONG'), { state: 's1', verifier: 'v' }, deps(google({})))
  ).toEqual({
    status: 400,
    body: {
      error: 'invalid_settings',
      message: 'Sign-in expired. Try connecting again.'
    }
  })
  expect(
    (
      await completeGoogleConnect(
        'm1',
        cb('code=c&state=s1'),
        { state: 's1', verifier: 'v' },
        deps(google({ refreshToken: null }))
      )
    ).body
  ).toMatchObject({
    message:
      "Google didn't send a refresh token. Remove TolongMeeting from your Google account's third-party access, then connect again."
  })
  const f = google({ existingFolder: 'F1' })
  const d = deps(f)
  expect((await completeGoogleConnect('m1', cb('code=c&state=s1'), { state: 's1', verifier: 'v' }, d)).status).toBe(200)
  expect((await d.connections.get('m1', 'google'))?.connection).toMatchObject({
    account: 'member@example.edu',
    folderId: 'F1',
    folderName: 'TolongMeeting Exports',
    folderIsDefault: true
  })
  expect(
    f.calls.some((c) => c.method === 'POST' && c.url.startsWith('https://www.googleapis.com/drive/v3/files'))
  ).toBe(false)
})
test('a picked folder must be a live folder', async () => {
  const connections = memoryStores({
    connections: [{ memberId: 'm1', connection: googleConn('F1', true) }]
  }).connections
  const pick = (id: string, file: object) =>
    setGoogleFolder('m1', { folderId: id }, { connections, client, http: google({ file }).fetch })
  expect(
    await pick('DOC1', {
      id: 'DOC1',
      name: 'Notes',
      mimeType: 'application/vnd.google-apps.document',
      trashed: false
    })
  ).toEqual({
    status: 400,
    body: { error: 'invalid_settings', message: 'Pick a folder, not a file.' }
  })
  expect(
    (
      await pick('F9', {
        id: 'F9',
        name: 'Lectures',
        mimeType: 'application/vnd.google-apps.folder',
        trashed: false
      })
    ).status
  ).toBe(200)
  expect((await connections.get('m1', 'google'))?.connection).toMatchObject({
    folderId: 'F9',
    folderName: 'Lectures',
    folderIsDefault: false
  })
})

// gdocs.test.ts
test('uploads one converted document into the folder', async () => {
  const f = drive({}) // token, folder GET, resumable POST -> Location, PUT -> { id, webViewLink }
  const r = await createGdocsTarget(client).run(
    await loadBundle(fixture),
    testContext({ http: f.fetch, connection: googleConn('F1', true) })
  )
  expect(JSON.parse(f.call('POST', /upload\/drive\/v3\/files/).body)).toEqual({
    name: '2026-10-20 1400 Data Mining',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['F1']
  })
  expect(r).toEqual({
    url: 'https://docs.google.com/document/d/D1/edit',
    filePath: null,
    note: null
  })
  expect(f.calls.filter((c) => ['PATCH', 'DELETE'].includes(c.method))).toEqual([])
})
test('gone folders, revoked access and a full Drive', async () => {
  const ctx = testContext({
    http: drive({ folder: 'trashed', newFolder: 'F2' }).fetch,
    connection: googleConn('F1', true)
  })
  await createGdocsTarget(client).run(await loadBundle(fixture), ctx)
  expect(ctx.saved[0]).toMatchObject({ folderId: 'F2', folderIsDefault: true })
  const run = async (o: object) =>
    createGdocsTarget(client).run(
      await loadBundle(fixture),
      testContext({
        http: drive(o).fetch,
        connection: googleConn('F1', false)
      })
    )
  await expect(run({ folder: 404 })).rejects.toMatchObject({
    code: 'not_found',
    message: 'The Drive folder you picked for exports is gone. Pick another on the Connections page.'
  })
  await expect(run({ token: 'invalid_grant' })).rejects.toMatchObject({
    code: 'reconnect_needed',
    message: 'Google access was removed or expired. Connect Google again on the Connections page.'
  })
  await expect(run({ upload: 'storageQuotaExceeded' })).rejects.toMatchObject({
    code: 'failed',
    message: "Your Google Drive is full, so the document wasn't created."
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/exports/src/connections/oauth.test.ts packages/exports/src/connections/google.test.ts packages/exports/src/targets/gdocs.test.ts`
Expected: FAIL with `Cannot find module './oauth'`, `Cannot find module './google'` and `Cannot find module './gdocs'`.

- [ ] **Step 3: Implement the OAuth helpers, the Google connection, the target and the routes; add `gdocs` to `buildTargets`**

State and verifier are 32 random bytes in base64url; the challenge is base64url SHA-256 of the verifier. Google endpoints: token `POST https://oauth2.googleapis.com/token` (form body; `authorization_code` with `code_verifier`, or `refresh_token`); account `GET https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)`; default folder `GET https://www.googleapis.com/drive/v3/files` with `q` `name = 'TolongMeeting Exports' and mimeType = 'application/vnd.google-apps.folder' and trashed = false` (with `drive.file` this sees only folders the app made), else `POST .../drive/v3/files` with that name and the folder MIME type. `setGoogleFolder` checks a picked folder with `GET .../files/{id}?fields=id,name,mimeType,trashed` (a file answers 400 "Pick a folder, not a file.", a trashed folder 400 "That folder is in the bin. Pick another."), saves it with `folderIsDefault: false`, and `{ useDefault: true }` switches back through `ensureDefaultFolder`. `createGdocsTarget(client).run`:

1.  `googleAccessToken` (a 400 `invalid_grant` or 401 throws `reconnect_needed` with the test's message).
1.  Check the folder: gone or trashed recreates it with `ensureDefaultFolder` and `ctx.saveConnection` when `folderIsDefault`, otherwise throws `not_found` with the test's message.
1.  `toDocx(bundleDocument(bundle), await bundleImages(bundle), bundle.title)`.
1.  Resumable upload: `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink` with the metadata in the test and `X-Upload-Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`, then `PUT` the bytes to the returned `Location`; a 403 with reason `storageQuotaExceeded` throws `failed` with the test's message.
1.  Return `webViewLink`. A re-export always creates a new document; earlier documents are never changed or deleted.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test packages/exports/src/connections/oauth.test.ts packages/exports/src/connections/google.test.ts packages/exports/src/targets/gdocs.test.ts packages/exports/src/registry.test.ts`
Expected: PASS (`0 fail`), with a registry case added: `buildTargets({ google: client, notion: null })` has keys `github`, `gdocs`, `pdf`, `zip`.

- [ ] **Step 5: Commit**

```bash
git add packages/exports packages/web/app/api/connections/google
git commit -m "feat(exports): add google docs target"
```

### Task 11: Notion block renderer

**Files:**

- Create: `packages/exports/src/render/notion.ts`
- Test: `packages/exports/src/render/notion.test.ts`

**Interfaces:**

- Consumes: `DocBlock`, `Run` (task 2).
- Produces: `type NotionBlock = Record<string, unknown>` (a Notion block object); `toNotionBlocks(doc: DocBlock[], uploads: Map<string, string>): NotionBlock[]` (bundle image path to Notion file upload id); `chunkBlocks(blocks: NotionBlock[], maxCount?: number, maxBytes?: number): NotionBlock[][]` (defaults 100 and 400,000 bytes of JSON).

- [ ] **Step 1: Write the failing test**

```ts
test('long text is split at 2,000 characters', () => {
  const [p] = toNotionBlocks([{ kind: 'paragraph', runs: [{ text: 'a'.repeat(4500) }] }], new Map())
  expect((p as any).paragraph.rich_text.map((t: any) => t.text.content.length)).toEqual([2000, 2000, 500])
})
test('more than 100 rich text items make more blocks', () => {
  const runs = Array.from({ length: 250 }, (_, i) => ({
    text: `w${i} `,
    bold: i % 2 === 0
  }))
  const blocks = toNotionBlocks([{ kind: 'paragraph', runs }], new Map())
  expect(blocks.map((b: any) => b.paragraph.rich_text.length)).toEqual([100, 100, 50])
})
test('maps headings, lists, images, tables and breaks', () => {
  const blocks = toNotionBlocks(
    [
      { kind: 'heading', level: 2, runs: [{ text: 'Slide 01: Welcome' }] },
      { kind: 'image', path: 'slides/01.webp', alt: 'Slide 01: Welcome' },
      {
        kind: 'list',
        ordered: true,
        items: [[{ text: 'one' }], [{ text: 'two' }]]
      },
      { kind: 'table', header: [[{ text: 'a' }]], rows: [[[{ text: '1' }]]] },
      { kind: 'break' }
    ],
    new Map([['slides/01.webp', 'UP1']])
  )
  expect(blocks.map((b: any) => b.type)).toEqual([
    'heading_2',
    'image',
    'numbered_list_item',
    'numbered_list_item',
    'table',
    'divider'
  ])
  expect((blocks[1] as any).image).toEqual({
    type: 'file_upload',
    file_upload: { id: 'UP1' },
    caption: [
      {
        type: 'text',
        text: { content: 'Slide 01: Welcome', link: null },
        annotations: { bold: false, italic: false, code: false }
      }
    ]
  })
  expect((blocks[4] as any).table).toMatchObject({
    table_width: 1,
    has_column_header: true
  })
})
test('chunks by count and size', () => {
  expect(
    chunkBlocks(Array.from({ length: 250 }, () => ({ type: 'divider', divider: {} }))).map((c) => c.length)
  ).toEqual([100, 100, 50])
  const big = {
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: 'x'.repeat(60_000) } }]
    }
  }
  expect(chunkBlocks(Array(10).fill(big)).map((c) => c.length)).toEqual([6, 4])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/exports/src/render/notion.test.ts`
Expected: FAIL with `Cannot find module './notion'`.

- [ ] **Step 3: Implement `toNotionBlocks` and `chunkBlocks` in `src/render/notion.ts`**

Headings 1 to 3 map to `heading_1` to `heading_3`; paragraphs to `paragraph`; list items to `numbered_list_item` or `bulleted_list_item`; tables to `table` with `table_row` children, split into tables of at most 99 rows that each repeat the header; images to `image` with `file_upload`; code to `code` with language `plain text`; `rule` and `break` to `divider`. Each run becomes text objects of at most 2,000 characters with `annotations` `{ bold, italic, code }` (false when unset) and `link` `{ url }` for `http` and `https` links, `null` otherwise; a block with more than 100 text objects is split into several blocks of the same type.

- [ ] **Step 4: Run it to see it pass**

Run: `bun test packages/exports/src/render/notion.test.ts`
Expected: PASS (`0 fail`).

- [ ] **Step 5: Commit**

```bash
git add packages/exports/src/render/notion.ts packages/exports/src/render/notion.test.ts
git commit -m "feat(exports): add notion block renderer"
```

### Task 12: Notion connection and target

**Files:**

- Create: `packages/exports/src/connections/notion.ts`, `packages/exports/src/targets/notion.ts`, `packages/web/app/api/connections/notion/start/route.ts`, `.../notion/callback/route.ts`, `.../notion/parents/route.ts`, `.../notion/parent/route.ts`
- Modify: `packages/exports/src/registry.ts` (add `notion` when the Notion client is configured)
- Test: `packages/exports/src/connections/notion.test.ts`, `packages/exports/src/targets/notion.test.ts`

**Interfaces:**

- Consumes: `NotionConnection`, `NotionParent`, `OAuthClient`, `loadBundle`, `fixture` (task 1); `bundleDocument` (task 2); `testContext` (task 3); `bundleImages` (task 4); `ConnectionStore` (task 5); `ApiResult` (task 7); `fakeFetch` (task 8); `stateCookie`, `readStateCookie`, `clearStateCookie`, `newOAuthState` (task 10); `toNotionBlocks`, `chunkBlocks` (task 11).
- Produces:

```ts
// connections/notion.ts
export const NOTION_VERSION = '2026-03-11'
export interface NotionClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>
  upload(filename: string, bytes: Uint8Array, contentType: string): Promise<string> // file upload id
}
export function createNotionClient(
  conn: NotionConnection,
  deps: {
    http: typeof fetch
    sleep(ms: number): Promise<void>
    saveConnection(c: NotionConnection): Promise<void>
    client: OAuthClient
  }
): NotionClient
export function notionAuthUrl(o: { client: OAuthClient; state: string }): string
export async function completeNotionConnect(
  memberId: string,
  url: URL,
  cookie: { state: string; verifier: string } | null,
  deps: {
    connections: ConnectionStore
    http: typeof fetch
    client: OAuthClient
  }
): Promise<ApiResult>
export async function listNotionParents(
  client: NotionClient
): Promise<{ type: NotionParent['type']; id: string; name: string }[]>
export async function resolveNotionParent(
  client: NotionClient,
  type: NotionParent['type'],
  id: string
): Promise<NotionParent>
// targets/notion.ts
export function createNotionTarget(client: OAuthClient): ExportTarget // id 'notion'
```

Routes: `GET /api/connections/notion/start` (redirect plus state cookie), `GET .../callback` (then redirect to `/connections`), `GET .../parents` (`{ parents }`), `PUT .../parent` (`{ type, id }`, resolved and saved).

- [ ] **Step 1: Write the failing tests**

```ts
// connections/notion.test.ts
const client = {
  clientId: 'nid',
  clientSecret: 'ns',
  redirectUri: 'https://tm.example/api/connections/notion/callback'
}
test('authorize URL', () => {
  const u = new URL(notionAuthUrl({ client, state: 's1' }))
  expect(u.origin + u.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
  expect(Object.fromEntries(u.searchParams)).toEqual({
    client_id: 'nid',
    response_type: 'code',
    owner: 'user',
    redirect_uri: 'https://tm.example/api/connections/notion/callback',
    state: 's1'
  })
})
test('client headers, spacing and rate limits', async () => {
  const f = notion({ search: [429, 200, 200], retryAfter: '2' })
  const ctx = { http: f.fetch, sleeps: [] as number[] } // deps(ctx) records sleeps into ctx.sleeps
  const c = createNotionClient(notionConn(), { ...deps(ctx), client })
  await c.request('POST', '/v1/search', {})
  await c.request('POST', '/v1/search', {})
  expect(f.calls[0].headers['notion-version']).toBe('2026-03-11')
  expect(ctx.sleeps).toEqual([2000, 340])
})
test('a 401 refreshes once and saves the rotated tokens', async () => {
  const saved: NotionConnection[] = []
  const f = notion({
    search: [401, 200],
    refresh: { access_token: 'ntn_new', refresh_token: 'r2' }
  })
  await createNotionClient(notionConn(), {
    http: f.fetch,
    sleep: async () => {},
    saveConnection: async (c) => {
      saved.push(c)
    },
    client
  }).request('POST', '/v1/search', {})
  expect(f.call('POST', '/v1/oauth/token').headers.authorization).toBe(`Basic ${btoa('nid:ns')}`)
  expect(saved[0]).toMatchObject({
    accessToken: 'ntn_new',
    refreshToken: 'r2'
  })
  await expect(
    createNotionClient(notionConn({ refreshToken: null }), {
      ...deps({ http: notion({ search: [401] }).fetch }),
      client
    }).request('POST', '/v1/search', {})
  ).rejects.toMatchObject({
    code: 'reconnect_needed',
    message: 'Notion access was removed. Connect Notion again on the Connections page.'
  })
})
test('a data source parent resolves its title property', async () => {
  const c = createNotionClient(notionConn(), {
    ...deps({
      http: notion({
        dataSource: { Name: { type: 'title' }, Date: { type: 'date' } }
      }).fetch
    }),
    client
  })
  expect(await resolveNotionParent(c, 'data_source_id', 'DS1')).toEqual({
    type: 'data_source_id',
    id: 'DS1',
    name: 'Lecture notes',
    titleProperty: 'Name'
  })
})

// targets/notion.test.ts
test('one page with uploaded slides, appended in chunks', async () => {
  const f = notion({ page: { id: 'P1', url: 'https://www.notion.so/P1' } })
  const r = await createNotionTarget(client).run(
    await loadBundle(fixture),
    testContext({
      http: f.fetch,
      connection: notionConn({ parent: pageParent })
    })
  )
  expect(JSON.parse(f.call('POST', '/v1/pages').body)).toEqual({
    parent: { type: 'page_id', page_id: 'PARENT' },
    properties: {
      title: { title: [{ text: { content: '2026-10-20 1400 Data Mining' } }] }
    }
  })
  expect(f.count('POST', '/v1/file_uploads')).toBe(2)
  expect(JSON.parse(f.call('POST', '/v1/file_uploads').body)).toEqual({
    filename: 'slide-01.jpg',
    content_type: 'image/jpeg'
  })
  expect(f.count('PATCH', '/v1/blocks/P1/children')).toBeGreaterThanOrEqual(1)
  expect(r).toEqual({
    url: 'https://www.notion.so/P1',
    filePath: null,
    note: null
  })
})
test('a database parent uses its title property', async () => {
  const f = notion({})
  await createNotionTarget(client).run(
    await loadBundle(fixture),
    testContext({
      http: f.fetch,
      connection: notionConn({ parent: dsParent })
    })
  )
  expect(JSON.parse(f.call('POST', '/v1/pages').body)).toMatchObject({
    parent: { type: 'data_source_id', data_source_id: 'DS1' },
    properties: {
      Name: { title: [{ text: { content: '2026-10-20 1400 Data Mining' } }] }
    }
  })
})
test('failures: no parent, lost parent, half-written page', async () => {
  const run = async (f: ReturnType<typeof notion>, parent: NotionParent | null = pageParent) =>
    createNotionTarget(client).run(
      await loadBundle(fixture),
      testContext({ http: f.fetch, connection: notionConn({ parent }) })
    )
  await expect(run(notion({}), null)).rejects.toMatchObject({
    code: 'invalid_settings'
  })
  await expect(run(notion({ pageCreate: 404 }))).rejects.toMatchObject({
    code: 'not_found',
    message: `TolongMeeting can't reach the Notion page "Lecture notes" any more. Share it with the TolongLabs integration again, or pick another on the Connections page.`
  })
  const f = notion({
    page: { id: 'P1', url: 'https://www.notion.so/P1' },
    append: [400]
  })
  await expect(run(f)).rejects.toThrow()
  expect(JSON.parse(f.call('PATCH', '/v1/pages/P1').body)).toEqual({
    in_trash: true
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/exports/src/connections/notion.test.ts packages/exports/src/targets/notion.test.ts`
Expected: FAIL with `Cannot find module './notion'`.

- [ ] **Step 3: Implement the client, the connection, the target and the routes; add `notion` to `buildTargets`**

Client: base `https://api.notion.com`, headers `Authorization: Bearer <accessToken>`, `Notion-Version: 2026-03-11`, JSON content type except for the upload `send`; every request except the client's first is preceded by `sleep(340)` (Notion allows about 3 per second on non-Business plans); 429 and 529 sleep `Retry-After` seconds (1 if absent) instead and resend, up to 5 retries, then throw `rate_limited`, "Notion is busy. Try again in a few minutes."; a 401 refreshes once through `POST /v1/oauth/token` (Basic auth, `grant_type: 'refresh_token'`; Notion rotates both tokens), saves the connection and retries, and otherwise throws `reconnect_needed` with the test's message. `upload`: `POST /v1/file_uploads` `{ filename, content_type }`, then `POST /v1/file_uploads/{id}/send` as multipart with field `file`. `completeNotionConnect` checks state like Google (Notion has no PKCE, so the cookie's verifier goes unused), exchanges the code with `POST /v1/oauth/token` (`grant_type: 'authorization_code'`, `code`, `redirect_uri`) and saves `{ accessToken, refreshToken, workspace: workspace_name, parent: null }`; during Notion's consent the member selects the pages to share. `listNotionParents` runs `POST /v1/search` twice, filtered to `page` and to `data_source`, page size 100, named by their titles. `resolveNotionParent`: a page reads `GET /v1/pages/{id}` and uses property `title`; a data source reads `GET /v1/data_sources/{id}` and uses the property of type `title`. `createNotionTarget(client).run` builds its client from `ctx.connection`, `ctx.http`, `ctx.sleep` and `ctx.saveConnection`, then:

1.  No parent throws `invalid_settings`, "Pick a Notion page or database for exports on the Connections page.".
1.  `POST /v1/pages` with the parent and the title property only (bodies as in the tests); 403 or 404 throws `not_found` with the test's message.
1.  Upload every slide as `slide-NN.jpg` from `bundleImages` (JPEG, since Notion's WebP support isn't documented; uploads must be attached within 1 hour).
1.  `chunkBlocks(toNotionBlocks(bundleDocument(bundle), uploads))`, each chunk sent in order with `PATCH /v1/blocks/{pageId}/children` `{ children }`.
1.  Any error after step 2 sends `PATCH /v1/pages/{pageId}` `{ in_trash: true }` (its own failure ignored) and rethrows, so no half-written page is left.
1.  Return the page `url`. A re-export always creates a new page; earlier pages are never changed.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test packages/exports/src/connections/notion.test.ts packages/exports/src/targets/notion.test.ts packages/exports/src/registry.test.ts`
Expected: PASS (`0 fail`), with a registry case added: both clients set gives all five targets.

- [ ] **Step 5: Commit**

```bash
git add packages/exports packages/web/app/api/connections/notion
git commit -m "feat(exports): add notion target"
```

### Task 13: Connections page

**Files:**

- Create: `packages/exports/src/connections/remove.ts`, `packages/web/app/api/connections/google/route.ts`, `packages/web/app/api/connections/notion/route.ts`, `packages/web/app/connections/page.tsx`, `packages/web/components/connections/github-card.tsx`, `packages/web/components/connections/google-card.tsx`, `packages/web/components/connections/notion-card.tsx`
- Modify: `packages/web/app/api/connections/github/route.ts` (add `DELETE`), 01c's site navigation (add "Connections" next to the other pages)
- Test: `packages/exports/src/connections/remove.test.ts`

**Interfaces:**

- Consumes: `ConnectionKind` (task 1); `ConnectionStore` (task 5); `memoryStores` (task 6); `connectionsRequest`, `ApiResult` (task 7); `fakeFetch` and the GitHub route (task 8); the Google routes (task 10); the Notion routes (task 12).
- Produces: `removeConnection(memberId: string, kind: ConnectionKind, deps: { connections: ConnectionStore; http: typeof fetch }): Promise<ApiResult>` (body `{ message }`); routes `DELETE /api/connections/github`, `DELETE /api/connections/google` and `DELETE /api/connections/notion` (one static route file each, since a dynamic `[kind]` route would lose to the static `github` folder); page `/connections`.

- [ ] **Step 1: Write the failing test**

```ts
test('Google removal revokes with the token in the body, even if revoking fails', async () => {
  for (const status of [200, 400]) {
    const f = fakeFetch([['POST', 'https://oauth2.googleapis.com/revoke', () => new Response('', { status })]])
    const deps = {
      connections: memoryStores({
        connections: [{ memberId: 'm1', connection: googleConn('F1', true) }]
      }).connections,
      http: f.fetch
    }
    expect(await removeConnection('m1', 'google', deps)).toEqual({
      status: 200,
      body: { message: 'Removed, and Google access revoked.' }
    })
    expect(f.calls[0].url).toBe('https://oauth2.googleapis.com/revoke')
    expect(f.calls[0].body).toBe('token=1%2F%2Frefresh')
    expect(await deps.connections.get('m1', 'google')).toBeNull()
  }
})
test('GitHub and Notion removal explain the last step and touch only the caller', async () => {
  const deps = {
    connections: memoryStores({
      connections: [{ memberId: 'm1', connection: githubConn('github_pat_x') }]
    }).connections,
    http: fakeFetch([]).fetch
  }
  expect((await removeConnection('m2', 'github', deps)).status).toBe(200)
  expect(await deps.connections.get('m1', 'github')).not.toBeNull()
  expect((await removeConnection('m1', 'github', deps)).body).toEqual({
    message:
      'Removed. Also delete the token on GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens.'
  })
  expect(await deps.connections.get('m1', 'github')).toBeNull()
  expect((await removeConnection('m1', 'notion', deps)).body).toEqual({
    message: 'Removed. To end access fully, disconnect TolongLabs in Notion under Settings, Connections.'
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/exports/src/connections/remove.test.ts`
Expected: FAIL with `Cannot find module './remove'`.

- [ ] **Step 3: Implement `removeConnection`, the route and the page**

`removeConnection` for Google posts `token=<refreshToken>` form-encoded to `https://oauth2.googleapis.com/revoke` and ignores its result; for every kind it removes only the signed-in member's row. The page shows one card per connection from `GET /api/connections`, with its status ("Connected as <label>", "Reconnect needed" or "Not connected"), its detail, and Remove (`DELETE /api/connections/<kind>`, then the returned message is shown). Card copy:

```text
GitHub
1. On GitHub, open Settings, Developer settings, Personal access tokens, Fine-grained tokens, and generate a new token.
2. Under Repository access, choose "Only select repositories" and pick the repository for your notes.
3. Under Repository permissions, set Contents to "Read and write".
4. Paste the token here. TolongMeeting keeps it encrypted and only uses it to commit your exports.
Fields: Repository owner, Repository name, Branch, Folder (blank for the top level), Token

Google Docs
TolongMeeting can only see files it creates or that you pick. Exports go to "TolongMeeting Exports" in your Drive unless you pick another folder.
Buttons: Connect Google, Pick a folder, Use "TolongMeeting Exports"

Notion
When Notion asks, select the page or database exports should go under. You can share more later from the page's menu, under Connections.
Buttons: Connect Notion; then a list of shared pages and databases to choose from
```

"Pick a folder" loads `https://apis.google.com/js/api.js`, calls `gapi.load('picker')`, fetches `/api/connections/google/picker`, and opens a `google.picker.PickerBuilder` with `setOAuthToken`, `setDeveloperKey(apiKey)`, `setAppId(appId)` and a `DocsView(ViewId.FOLDERS)` with `setSelectFolderEnabled(true)` and `setMimeTypes('application/vnd.google-apps.folder')`; the picked id goes to `PUT /api/connections/google/folder`. If 01c sets a Content-Security-Policy, `/connections` allows scripts from `https://apis.google.com` and frames from `https://docs.google.com`.

- [ ] **Step 4: Run it to see it pass**

Run: `bun test packages/exports/src/connections/remove.test.ts && bun run typecheck`
Expected: PASS (`0 fail`); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/exports/src/connections/remove.ts packages/exports/src/connections/remove.test.ts packages/web
git commit -m "feat(web): add connections page"
```

### Task 14: Milestone acceptance

Manual checks on the deployed stack with real accounts, mapped to the design's goal 5 ("Let the member export them to Google Docs, GitHub, Notion and file downloads"), the security finding SEC-11, and the isolation and retention acceptance tests. Use a completed test lecture from the 01c acceptance run and TolongLabs test accounts only.

**Files:**

- Modify: `docs/plans/07-exports.md` (tick the boxes and note the date of each pass)

**Interfaces:**

- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Set up the TolongLabs-owned clients**

Procedure: in a Google Cloud project owned by the TolongLabs Google account, enable the Drive API and the Google Picker API, configure the OAuth consent screen as External with the single scope `https://www.googleapis.com/auth/drive.file`, publish it "In production", create a web client with redirect URI `<TM_PUBLIC_URL>/api/connections/google/callback`, and an API key restricted to the Picker API and the referrer `<TM_PUBLIC_URL>/*`. In the TolongLabs Notion workspace, create a public integration with the capabilities "Read content" and "Insert content", no user email, and redirect URI `<TM_PUBLIC_URL>/api/connections/notion/callback`. Put the six variables in the server's environment and restart `web` and `exports`.
Pass: `docker compose ps` shows `exports` running; the consent screen shows "In production" and lists only `drive.file`.

- [ ] **Step 2: Downloads**

Procedure: on the test lecture's meeting page press "Download Markdown (.zip)" and "Download PDF".
Pass: both files download within 30 seconds and both "Export finished" pings arrive; the zip unpacks to one folder holding `YYYY-MM-DD HHmm <entry name>.md`, `transcript.md`, `slides.md`, `chat.md` and `slides/NN.webp`, and `slides.md` shows its images in a Markdown preview; the PDF starts with the summary and shows every slide image.

- [ ] **Step 3: GitHub**

Procedure: in a private TolongLabs test repository, create a fine-grained token with "Only select repositories" set to it and Contents "Read and write"; save it on the Connections page with folder `meetings` and branch `main`; export; export again; then delete the token on GitHub and export a third time.
Pass: a classic `ghp_` token is refused when saving; the first export makes one commit `docs: add <date> <time> <entry name>` (50 characters at most) with the set under `meetings/<dirName>/`; the second reports "already up to date" and adds no commit; the third fails with the reconnect message, the GitHub card shows "Reconnect needed", and an "Export failed" ping with a Reconnect button arrives.

- [ ] **Step 4: Google Docs**

Procedure: connect Google; export; pick a different folder with the Picker; export again; open the Google Account's third-party access page.
Pass: "TolongMeeting Exports" appears in Drive with one document holding the summary, slides with images, transcript and chat; the second export lands in the picked folder as a new document and the first is unchanged; the access page lists only access to files the app uses. Eight or more days after connecting, a further export still succeeds (proving the client is in production).

- [ ] **Step 5: Notion**

Procedure: connect Notion, sharing one test page and one test database; choose the page and export; choose the database and export; then remove the integration's access to the database in Notion and export again.
Pass: each export makes one new page with slide images, under the page and as a database row respectively; the last fails with the "can't reach the Notion page" message and pings.

- [ ] **Step 6: Isolation, secrets and retention**

Procedure: as a second test member, request the first member's export file URL, `POST /api/meetings/<occurrenceId>/exports` for the first member's meeting, and `GET /api/connections`; send the same requests with a companion device token; search `docker compose logs web exports` and the `connections` table for `github_pat_`, `ntn_`, `ya29.` and `1//`; then set the test meeting's date 31 days back and run 01c's retention job.
Pass: every cross-member and device-token request gets 404 or 401 and the second member sees no connections; no token appears in logs or as plaintext in the table; after retention the meeting's `exports` rows and `exports/` files are gone within an hour, while the exported zip, PDF, GitHub commit, Google Doc and Notion pages are all still there.

- [ ] **Step 7: Commit**

```bash
git add docs/plans/07-exports.md
git commit -m "docs: record exports acceptance results"
```
