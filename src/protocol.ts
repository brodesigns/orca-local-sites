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
  /** The workspace you are in right now: listed first */
  current: boolean
  /** Pinned as favorite */
  pinned: boolean
  /** Hidden from the list */
  hidden: boolean
  /** No node_modules yet: Start installs the dependencies first */
  needsInstall: boolean
  /** An agent finished in this project and it is not running: ready to view */
  readyHint: boolean
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

export type Config = {
  /** Show the command and the port before a start */
  confirmStart: boolean
  /** Try to open the browser as soon as a started server is ready */
  openWhenReady: boolean
  /** Desktop notification when a server stops unexpectedly or shows errors */
  notify: boolean
  /** Hint (and notification) when an agent finished in a project that is not running */
  readyHint: boolean
  /** Start such a project right away */
  autoStartAfterAgent: boolean
  /** Agent that "Fix with agent" launches */
  fixAgent: string
}

export type PortEntry = {
  port: number
  pid: number
  process: string
  /** Project (a row of the list) whose folder the process runs in */
  project: string | null
  /** Id of that project, to match it with its row */
  projectId: string | null
  /** Started by this plugin */
  ours: boolean
}

export type PortsState = {
  ports: PortEntry[]
  /** lsof is missing or failed */
  unavailable: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'sites.get': { output: SitesState }
    'sites.refresh': { output: SitesState }
    'site.plan': { input: { id: string }; output: { command: string; port: number } }
    'site.start': { input: { id: string; port?: number }; output: SitesState }
    'ports.get': { output: PortsState }
    'site.stopExternal': { input: { id: string; pid: number; port: number }; output: { ok: true } }
    'site.fix': { input: { id: string }; output: { ok: true } }
    'site.pin': { input: { id: string; pinned: boolean }; output: SitesState }
    'site.hide': { input: { id: string; hidden: boolean }; output: SitesState }
    'site.dismissHint': { input: { id: string }; output: SitesState }
    'config.get': { output: Config }
    'config.set': { input: Partial<Config>; output: Config }
    'site.stop': { input: { id: string }; output: SitesState }
    'site.show': { input: { id: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    'sites.changed': SitesState
  }
}
