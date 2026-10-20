// Types shared by the identity form (a client component), its server action and the Accounts page. Nothing here
// touches the server, so the client component can import it.

export interface IdentityFormValues {
  name: string
  zoomGuestName: string
  orgName: string
  orgEmailDomain: string
}

export type IdentityFormState =
  | { status: 'idle' }
  | {
      status: 'error'
      /** A problem that belongs to no single field. */
      message?: string
      /** Field name to message. */
      fields: Partial<Record<keyof IdentityFormValues, string>>
      /** What the member typed, so a refused form keeps it. */
      values: IdentityFormValues
    }
