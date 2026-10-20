// The AI key form's state. Nothing here touches the server, so the client form can import it. It never holds a key.

export type KeyFormState = { status: 'idle' } | { status: 'error'; message?: string; fields: Record<string, string> }
