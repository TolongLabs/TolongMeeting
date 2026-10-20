// The pairing form's state. Nothing here touches the server, so the client form can import it. The code is the only
// secret in it: it lives in the form's memory until the page is left or reloaded.

export type PairState =
  { status: 'idle' } | { status: 'created'; code: string; validUntil: string } | { status: 'error'; message: string }
