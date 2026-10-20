// The details form's state. Nothing here touches the server, so the client form can import it.

export type DetailsFormState =
  | { status: 'idle' }
  | {
      status: 'error'
      /** A problem that belongs to no single field. */
      message?: string
      /** Field id to message. */
      fields: Record<string, string>
      /** What the member typed, by field name, so a failed save keeps their work. */
      values: Record<string, string>
    }

/** The detail rows the form always shows, with the labels the member may add. */
export const CUSTOM_ROWS = 3
