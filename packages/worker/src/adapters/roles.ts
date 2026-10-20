import type { SenderRole } from '@tm/core'

// Roster rows (each a list of text lines: the name first, the labels after it) to a role per trimmed, lower-cased name,
// using the platform's `roleOf` for the lines after the name. Only those lines count as a label, so a participant named
// "Host" is not one. A name that appears more than once with different roles (a student who renamed themselves to the
// lecturer's name) is `unknown`, so neither entry is trusted. Shared by the Teams roster and the Meet People panel.
export function rolesByName(rows: string[][], roleOf: (label: string) => SenderRole): Map<string, SenderRole> {
  const roles = new Map<string, SenderRole>()
  for (const lines of rows) {
    const name = lines[0]?.trim().toLowerCase()
    if (!name) continue
    const role = roleOf(lines.slice(1).join('\n'))
    const earlier = roles.get(name)
    roles.set(name, earlier === undefined || earlier === role ? role : 'unknown')
  }
  return roles
}
