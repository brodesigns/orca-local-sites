// Panel <-> worker contract, declared once
export {}

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'
export type SiteStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export type Site = {
  /** Orca workspace id */
  id: string
  name: string
  branch: string | null
  /** Package manager or the tool that serves the site (php, python, playground) */
  runner: string
  /** Detected project type, e.g. Next.js, Vite, WordPress, PHP */
  framework: string
  status: SiteStatus
  port: number | null
  /** http://localhost:PORT, only while the server answers */
  url: string | null
  /** Why the start failed (status "error") */
  error: string | null
  /** The server runs but stopping it failed */
  warning: string | null
  /** A dev server of this project that already runs elsewhere, e.g. started by hand */
  foreignUrl: string | null
  /** The server runs but its output contains errors that are not fixed yet */
  hasErrors: boolean
  /** Errors from the output with a little context, prompts and request lines left out */
  problems: string[]
  /** Last lines of the terminal, plain text */
  log: string[]
}

export type SitesState = {
  sites: Site[]
  updatedAt: number
}

declare module 'orca' {
  interface PluginRequests {
    'sites.get': { output: SitesState }
    'sites.refresh': { output: SitesState }
    'site.start': { input: { id: string }; output: SitesState }
    'site.stop': { input: { id: string }; output: SitesState }
    'site.show': { input: { id: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    'sites.changed': SitesState
  }
}
