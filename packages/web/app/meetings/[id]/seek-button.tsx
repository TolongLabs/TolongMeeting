'use client'

/**
 * A transcript time that moves the meeting video (`#meeting-video`) to that point and plays it. Without JavaScript it
 * does nothing, and the time stays readable as text.
 */
export function SeekButton({ seconds, label }: { seconds: number; label: string }) {
  return (
    <button
      type="button"
      className="seek"
      aria-label={`Play the video from ${label}`}
      onClick={() => {
        const video = document.getElementById('meeting-video')
        if (!(video instanceof HTMLVideoElement)) return
        video.currentTime = seconds
        video.play().catch((e: unknown) => {
          if (
            (typeof DOMException !== 'undefined' &&
              e instanceof DOMException &&
              (e.name === 'AbortError' || e.name === 'NotAllowedError')) ||
            (e instanceof Error && (e.name === 'AbortError' || e.name === 'NotAllowedError'))
          ) {
            return
          }
          throw e
        })
      }}
    >
      {label}
    </button>
  )
}
