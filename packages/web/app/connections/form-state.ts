// The connection forms' state. Nothing here touches the server, so the client forms can import it. It never holds a
// token: the GitHub token is read from the form once, sent to the server and left out of every result.

import type { GitHubFields } from '../../lib/connections-view'

export type { GitHubFields }

export type GitHubFormState = { status: 'idle' } | { status: 'error'; message: string; values: GitHubFields }

export type FolderFormState = { status: 'idle' } | { status: 'error'; message: string }
