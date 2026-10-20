import type { ResolvedForm, TrustReason } from '@tm/core'

export interface TrustDecision {
  trusted: boolean
  reason: TrustReason | null
}

const TRAILING_SUFFIX = /\s*\([^()]*\)$/

// Lowercases, collapses whitespace and drops trailing parenthesised suffixes such as "(Guest)".
function normaliseName(name: string): string {
  let n = name.trim().replace(/\s+/g, ' ').toLowerCase()
  while (TRAILING_SUFFIX.test(n)) n = n.replace(TRAILING_SUFFIX, '')
  return n
}

const trusted = (reason: TrustReason): TrustDecision => ({ trusted: true, reason })

// Decides trust before the form is opened. The bot never opens the form itself in 1A.
export function checkTrust(
  f: Pick<ResolvedForm, 'source' | 'sender' | 'senderRole'>,
  trustedSenders: string[]
): TrustDecision {
  if (f.source === 'qr') return trusted('qr_on_screen')
  if (f.source === 'meeting_chat') {
    if (f.senderRole === 'host') return trusted('host')
    if (f.senderRole === 'co_host') return trusted('co_host')
  }
  // A name the platform could not tell apart (listed twice with different roles, so a student may have copied the
  // trusted person's name) is not trusted by name. Chats watched outside the meeting give no role, so they are exempt.
  const ambiguous = f.source === 'meeting_chat' && f.senderRole === 'unknown'
  if (f.sender !== null && !ambiguous) {
    const name = normaliseName(f.sender)
    if (name !== '' && trustedSenders.some((t) => normaliseName(t) === name)) return trusted('trusted_sender')
  }
  return { trusted: false, reason: null }
}
