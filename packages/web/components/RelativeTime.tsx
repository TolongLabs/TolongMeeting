import { formatWhen } from '@tm/core'

/**
 * A moment as the member's own clock shows it, for example `Wed 21 Oct, 14:00`, in a `<time>` with the exact instant.
 * `timeZone` is the member's IANA zone (`(await scope.me()).timeZone`).
 */
export function RelativeTime({ at, timeZone }: { at: Date | string; timeZone: string }) {
  const date = new Date(at)
  return <time dateTime={date.toISOString()}>{formatWhen(date, timeZone)}</time>
}
