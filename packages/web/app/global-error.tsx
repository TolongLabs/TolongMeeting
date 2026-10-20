'use client'

import './globals.css'

/** Used when the layout itself fails (for example the database is down). Same plain copy; no message or id. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <main>
          <title>Something went wrong | TolongMeeting</title>
          <h1>Something went wrong</h1>
          <p>TolongMeeting could not load. Try again. If it keeps failing, tell an admin.</p>
          <button type="button" onClick={() => retry()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
