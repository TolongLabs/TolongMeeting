import { FormField } from '../../../components/FormField'
import { SubmitButton } from '../../../components/SubmitButton'
import { pasteLinkAction } from './actions'

interface CurrentLink {
  host: string
  meetingId: string | null
}

export function PasteLinkForm({
  id,
  currentLink,
  error
}: {
  id: string
  currentLink: CurrentLink | null
  error?: string
}) {
  return (
    <section id="paste-link" aria-labelledby="paste-link-heading">
      <h2 id="paste-link-heading">Meeting link</h2>
      {currentLink !== null && (
        <p>
          Current link:{' '}
          {currentLink.meetingId ? `${currentLink.host}, meeting ${currentLink.meetingId}` : currentLink.host}.
        </p>
      )}
      <form action={pasteLinkAction}>
        <input type="hidden" name="id" value={id} />
        <FormField
          id="meeting-link"
          label="Meeting link"
          hint="A Zoom, Teams or Meet link that starts with https://. Paste the whole link."
          error={error}
        >
          {(field) => (
            <input {...field} name="link" type="url" inputMode="url" autoComplete="off" spellCheck={false} required />
          )}
        </FormField>
        <SubmitButton pendingLabel="Saving…">Save link</SubmitButton>
      </form>
    </section>
  )
}
