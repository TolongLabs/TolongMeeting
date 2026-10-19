// Control-channel and sign-in contracts shared by the website, the scheduler and the worker (plan 01c).

export const ACCOUNT_KINDS = ['zoom', 'microsoft', 'google', 'whatsapp', 'discord', 'teams'] as const

export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export type AccountStatus = Partial<Record<AccountKind, { verifiedAt: string; signedIn: boolean }>>
