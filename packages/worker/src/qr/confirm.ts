// A code counts once it was decoded in two consecutive frames; each text is reported once per meeting.
export class QrConfirmer {
  private previous = new Set<string>()
  private readonly reported = new Set<string>()

  push(texts: string[]): string[] {
    const current = new Set(texts)
    const confirmed = [...current].filter((t) => this.previous.has(t) && !this.reported.has(t))
    for (const t of confirmed) this.reported.add(t)
    this.previous = current
    return confirmed
  }
}
