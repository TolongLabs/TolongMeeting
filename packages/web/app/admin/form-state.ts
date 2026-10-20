// The admin forms' state. Nothing here touches the server, so the client form can import it.

export type AddMemberState =
  | { status: 'idle' }
  | { status: 'error'; message?: string; fields: Record<string, string>; values: Record<string, string> }
