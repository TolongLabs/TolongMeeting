import { join } from 'node:path'

/** `%APPDATA%\TolongMeeting`, `%LOCALAPPDATA%\TolongMeeting` and Documents. */
export interface CompanionPaths {
  userData: string
  localData: string
  documents: string
}

const DIR = 'TolongMeeting'

export interface PathRoots {
  platform: NodeJS.Platform
  /** `%APPDATA%` (Electron `appData`). */
  appData: string
  /** `%LOCALAPPDATA%`. Required on Windows; other platforms only run the companion for development. */
  localAppData: string | undefined
  documents: string
}

export function resolvePaths(roots: PathRoots): CompanionPaths {
  const userData = join(roots.appData, DIR)
  if (roots.platform === 'win32') {
    if (!roots.localAppData) throw new Error('LOCALAPPDATA is not set')
    return { userData, localData: join(roots.localAppData, DIR), documents: roots.documents }
  }
  return { userData, localData: join(userData, 'local'), documents: roots.documents }
}

export const settingsFile = (p: CompanionPaths): string => join(p.userData, 'settings.json')
export const stateFile = (p: CompanionPaths): string => join(p.userData, 'state.json')
export const secretsFile = (p: CompanionPaths): string => join(p.userData, 'secrets.json')
/** Scratch space for job files. */
export const jobsDir = (p: CompanionPaths): string => join(p.localData, 'jobs')
