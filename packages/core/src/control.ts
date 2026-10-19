// Control-channel and sign-in contracts shared by the website, the scheduler and the worker (plan 01c).

export const ACCOUNT_KINDS = ['zoom', 'microsoft', 'google', 'whatsapp', 'discord', 'teams'] as const

export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export type AccountStatus = Partial<Record<AccountKind, { verifiedAt: string; signedIn: boolean }>>

/** The host paths and public URLs a container spec is built from (shared by the scheduler, the website and the pipeline). */
export type SpecEnv = { dataRoot: string; profileRoot: string; publicUrl: string; ntfyUrl: string }
