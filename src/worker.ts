// Worker: finds web projects, runs their dev server in a visible Orca terminal,
// watches the terminal output and answers the panel
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  blueprintFor,
  cleanLines,
  detectProject,
  devCommand,
  fatalStartLine,
  newLines,
  problemsFrom,
  portConflictLine,
  portFromLog,
  siteLabel,
  PORT_MIN,
  preferredPort,
  type Kind,
  type ProjectInfo,
  type WordPressRun
} from './projects'
import type { Site, SiteStatus, SitesState } from './protocol'

const TICK_MS = 1500
const START_TIMEOUT_MS = 120_000
const MAX_WORKSPACES = 100
const LOG_LINES = 40
const READ_LINES = 150
const HISTORY_LINES = 400
const STOP_TIMEOUT_MS = 20_000
const LOCAL_HOST = 'local'
const RUNNER: Partial<Record<Kind, string>> = { static: 'python', php: 'php', wordpress: 'playground' }
// WordPress Playground downloads WordPress on the first start
const LONG_START_MS = 300_000
// Playground opens its port while WordPress still boots and answers 502 until it prints this
const PLAYGROUND_READY = /\bReady!/

type Workspace = { id: string; name: string; path: string; branch: string | null; hostId: string | null }
type Session = {
  terminalId: string
  port: number
  startedAt: number
  status: SiteStatus
  error: string | null
  /** Last terminal lines, raw */
  log: string[]
  /** Everything new since the start, to keep errors that scrolled off the terminal */
  history: string[]
  snapshot: string[]
  problems: string[]
  timeoutMs: number
  /** Output line that says the server is really ready (the port may open earlier) */
  readyMarker: RegExp | null
  stoppedAt?: number
  /** The server runs but could not be stopped (shown as a warning, not cleared by the next tick) */
  warning: string | null
  /** A server of this project that already runs elsewhere (port from its announcement) */
  foreignPort: number | null
}

/** True if something accepts connections on the port (IPv4 or IPv6 loopback) */
export function isPortOpen(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ port, host })
      const done = (ok: boolean) => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(400, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    })
  return probe('127.0.0.1').then((ok) => ok || probe('::1'))
}

export default function activate(orca: OrcaWorkerApi): void {
  let workspaces: Workspace[] = []
  const projects = new Map<string, ProjectInfo>() // by workspace id, Next.js projects only
  const sessions = new Map<string, Session>()
  let lastSignature = ''
  let timer: ReturnType<typeof setInterval> | undefined

  const urlOf = (port: number) => `http://localhost:${port}`

  function snapshot(): SitesState {
    const sites: Site[] = []
    for (const ws of workspaces) {
      const info = projects.get(ws.id)
      if (!info) continue
      const s = sessions.get(ws.id)
      sites.push({
        id: ws.id,
        name: siteLabel(ws.path, ws.name),
        branch: ws.branch,
        runner: RUNNER[info.kind] ?? info.manager ?? '',
        framework: info.label,
        status: s?.status ?? 'stopped',
        port: s?.port ?? null,
        url: s && (s.status === 'running' || s.status === 'stopping') ? urlOf(s.port) : null,
        error: s?.error ?? null,
        warning: s?.warning ?? null,
        foreignUrl: s?.foreignPort ? urlOf(s.foreignPort) : null,
        hasErrors: (s?.problems.length ?? 0) > 0,
        problems: s?.problems ?? [],
        log: s?.log ?? []
      })
    }
    sites.sort((a, b) => a.name.localeCompare(b.name))
    return { sites, updatedAt: Date.now() }
  }

  function publish(force = false): SitesState {
    const state = snapshot()
    const signature = JSON.stringify(state.sites)
    if (force || signature !== lastSignature) {
      lastSignature = signature
      orca.panels.post('sites.changed', state)
    }
    return state
  }

  async function persist(): Promise<void> {
    const data: Record<string, { terminalId: string; port: number }> = {}
    for (const [id, s] of sessions) {
      if (isActive(s)) data[id] = { terminalId: s.terminalId, port: s.port }
    }
    await orca.storage.set('sessions', data)
  }

  async function scan(): Promise<void> {
    const res = await orca.host.call('workspace.list')
    // Only workspaces on this machine: the folder is read from the local disk
    const list = res.workspaces.filter((w) => w.hostId === null || w.hostId === LOCAL_HOST).slice(0, MAX_WORKSPACES)
    const next = new Map<string, ProjectInfo>()
    await Promise.all(
      list.map(async (w) => {
        const info = await detectProject(w.path)
        if (info) next.set(w.id, info)
        else if (isActive(sessions.get(w.id))) {
          // A half-written file must not orphan a running server
          const old = projects.get(w.id)
          if (old) next.set(w.id, old)
        }
      })
    )
    // Swap at the end, so a request during the scan never sees an empty list
    workspaces = list
    projects.clear()
    for (const [id, info] of next) projects.set(id, info)
    for (const id of sessions.keys()) if (!projects.has(id)) sessions.delete(id)
  }

  const isActive = (s: Session | undefined): s is Session => !!s && (s.status === 'starting' || s.status === 'running' || s.status === 'stopping')

  async function readTerminal(s: Session): Promise<string[] | null> {
    try {
      const r = await orca.host.call('terminal.read', { terminalId: s.terminalId, maxLines: READ_LINES })
      return cleanLines(r.lines, READ_LINES)
    } catch {
      return null // terminal closed by the person
    }
  }

  const otherPorts = (s: Session) => new Set([...sessions.values()].filter((o) => o !== s && isActive(o)).map((o) => o.port))

  async function tickSession(s: Session): Promise<void> {
    if (!isActive(s)) return
    const lines = await readTerminal(s)
    if (lines) {
      s.log = lines.slice(-LOG_LINES)
      s.history = [...s.history, ...newLines(s.snapshot, lines)].slice(-HISTORY_LINES)
      s.snapshot = lines
      s.problems = problemsFrom(s.history)
    }
    // The port was taken: whatever answers there is not our server
    if (s.status === 'starting') {
      const conflict = portConflictLine(s.log)
      if (conflict) {
        ;[s.status, s.error] = ['error', conflict]
        // "Another dev server is already running": remember where, so the panel can offer it
        if (/already running/i.test(conflict)) s.foreignPort = portFromLog(s.log, new Set([s.port]))
        await persist()
        return
      }
    }
    let open = await isPortOpen(s.port)
    // The script may choose its own port: follow the port it announces, if ours stays closed
    if (!open && s.status === 'starting') {
      const announced = portFromLog(s.log, otherPorts(s))
      if (announced && announced !== s.port) {
        s.port = announced
        open = await isPortOpen(s.port)
        await persist()
      }
    }
    const serverReady = !s.readyMarker || s.history.some((l) => s.readyMarker!.test(l))
    if (open && s.status === 'starting' && !serverReady) {
      // The port answers but the server is still booting: keep waiting. After the timeout it
      // counts as running, because it answers and stays stoppable.
      if (Date.now() - s.startedAt > s.timeoutMs) s.status = 'running'
    } else if (open && s.status === 'stopping') {
      // The terminal is closed but the port is still open: the server did not end
      if (Date.now() - (s.stoppedAt ?? 0) > STOP_TIMEOUT_MS) {
        s.status = 'running'
        s.warning = 'The server did not stop. Check for a leftover process on this port.'
      }
    } else if (open && s.status === 'running' && !lines) {
      // The terminal is gone but the port is still in use: Stop cannot reach it any more
      s.error = 'The terminal was closed but the port is still in use. A leftover process may be running.'
      s.status = 'error'
    } else if (open) {
      s.status = 'running'
      s.error = null
    } else if (s.status === 'stopping' || s.status === 'running') {
      // Server is gone (stopped, crashed or terminal closed)
      s.status = 'stopped'
      s.warning = null
    } else if (s.status === 'starting') {
      const fatal = fatalStartLine(s.log)
      if (fatal) [s.status, s.error] = ['error', fatal]
      else if (!lines) [s.status, s.error] = ['stopped', null]
      else if (Date.now() - s.startedAt > s.timeoutMs) [s.status, s.error] = ['error', 'Timed out waiting for the dev server']
    }
    if (!isActive(s)) {
      await persist()
      for (const [id, session] of sessions) if (session === s) await cleanupRunDir(id)
    }
  }

  // Only one tick at a time (interval and manual refresh must not overlap)
  let tickInFlight: Promise<void> | null = null
  function tick(): Promise<void> {
    tickInFlight ??= doTick().finally(() => {
      tickInFlight = null
    })
    return tickInFlight
  }

  async function doTick(): Promise<void> {
    await Promise.all([...sessions.values()].map(tickSession))
    publish()
    syncTimer()
  }

  function syncTimer(): void {
    const active = [...sessions.values()].some(isActive)
    if (active && !timer) timer = setInterval(() => void tick().catch((e) => orca.log(`tick failed: ${String(e)}`)), TICK_MS)
    if (!active && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  async function freePort(id: string): Promise<number> {
    const taken = new Set([...sessions].filter(([k, s]) => k !== id && isActive(s)).map(([, s]) => s.port))
    let port = preferredPort(id)
    for (let i = 0; i < 700; i++) {
      if (!taken.has(port) && !(await isPortOpen(port))) return port
      port = port + 1 >= PORT_MIN + 700 ? PORT_MIN : port + 1
    }
    throw new Error('No free port found')
  }

  function known(id: unknown): string {
    if (typeof id !== 'string' || !projects.has(id)) throw new Error('Unknown project')
    return id
  }

  // Private temp folder per WordPress run (0700, random name): npx starts there and the blueprint lies in it
  const runDirs = new Map<string, string>()

  async function cleanupRunDir(id: string): Promise<void> {
    const dir = runDirs.get(id)
    if (!dir) return
    runDirs.delete(id)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  async function prepareWordPress(id: string, info: ProjectInfo, project: string): Promise<WordPressRun> {
    await cleanupRunDir(id)
    const workDir = await mkdtemp(join(tmpdir(), 'orca-local-sites-'))
    runDirs.set(id, workDir)
    if (!info.plugins.length) return { workDir, project }
    const blueprint = join(workDir, 'blueprint.json')
    await writeFile(blueprint, blueprintFor(info.plugins), { mode: 0o600, flag: 'wx' })
    return { workDir, project, blueprint }
  }

  // Starts run one after another: each one sees the port the previous one took
  let startChain: Promise<unknown> = Promise.resolve()
  function start(rawId: unknown): Promise<SitesState> {
    const run = startChain.then(() => doStart(rawId))
    startChain = run.catch(() => undefined)
    return run
  }

  async function doStart(rawId: unknown): Promise<SitesState> {
    const id = known(rawId)
    const info = projects.get(id)!
    const ws = workspaces.find((w) => w.id === id)!
    const current = sessions.get(id)
    // Never start twice
    if (isActive(current)) return publish()
    // Close the terminal of the previous run, so they do not pile up (best effort)
    if (current?.terminalId) await orca.host.call('terminal.close', { terminalId: current.terminalId }).catch(() => undefined)
    const port = await freePort(id)
    const { terminalId } = await orca.host.call('terminal.create', {
      workspaceId: ws.id,
      title: `dev: ${ws.name}`,
      command: devCommand(info, port, info.kind === 'wordpress' ? await prepareWordPress(id, info, ws.path) : undefined)
    })
    sessions.set(id, { terminalId, port, startedAt: Date.now(), status: 'starting', error: null, log: [], history: [], snapshot: [], problems: [], timeoutMs: info.kind === 'wordpress' ? LONG_START_MS : START_TIMEOUT_MS, readyMarker: info.kind === 'wordpress' ? PLAYGROUND_READY : null, warning: null, foreignPort: null })
    await persist()
    syncTimer()
    return publish(true)
  }

  async function stop(rawId: unknown): Promise<SitesState> {
    const id = known(rawId)
    const s = sessions.get(id)
    if (s && (s.status === 'starting' || s.status === 'running')) {
      // Closing the terminal ends the server. Ctrl+C would only work in the focused workspace.
      const closed = await orca.host
        .call('terminal.close', { terminalId: s.terminalId })
        .then(() => true)
        .catch((e) => {
          orca.log(`stop failed: ${String(e)}`)
          return false
        })
      // Never claim "stopped" while the server may still run
      // A terminal that no longer exists is closed already
      if (!closed && (await readTerminal(s))) throw new Error('Could not stop the server. Close its terminal in Orca.')
      s.warning = null
      s.stoppedAt = Date.now()
      s.status = 'stopping'
      await persist()
      syncTimer()
    }
    return publish(true)
  }

  // Take over servers started before the worker restarted
  async function restore(): Promise<void> {
    const saved = await orca.storage.get('sessions')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
    for (const [id, v] of Object.entries(saved)) {
      if (!v || typeof v !== 'object') continue
      const e = v as { terminalId?: unknown; port?: unknown }
      if (typeof e.terminalId !== 'string' || !Number.isInteger(e.port) || !projects.has(id)) continue
      const port = e.port as number
      if (port < 1024 || port > 65535 || !(await isPortOpen(port))) continue
      const session: Session = { terminalId: e.terminalId, port, startedAt: Date.now(), status: 'running', error: null, log: [], history: [], snapshot: [], problems: [], timeoutMs: START_TIMEOUT_MS }
      // The terminal must still exist, else a foreign server on that port would look like ours
      if (!(await readTerminal(session))) continue
      sessions.set(id, session)
    }
  }

  const ready = scan()
    .then(restore)
    .then(() => {
      publish(true)
      syncTimer()
    })
    .catch((e) => orca.log(`scan failed: ${String(e)}`))

  orca.panels.handle('sites.get', async () => {
    await ready
    return snapshot()
  })
  orca.panels.handle('sites.refresh', async () => {
    await scan()
    await tick()
    return publish(true)
  })
  orca.panels.handle('site.start', async ({ id }) => start(id))
  orca.panels.handle('site.stop', async ({ id }) => stop(id))
  orca.panels.handle('site.show', async ({ id }) => {
    const s = sessions.get(known(id))
    if (!s?.terminalId) throw new Error('No terminal yet. Start the project first.')
    await orca.host.call('terminal.focus', { terminalId: s.terminalId })
    return { ok: true as const }
  })

  orca.commands.register('refresh', async () => {
    await scan()
    await tick()
    return `${projects.size} projects`
  })

  cleanup = () => {
    clearInterval(timer)
    for (const dir of runDirs.values()) void rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

let cleanup: (() => void) | undefined

export function deactivate(): void {
  cleanup?.()
}
