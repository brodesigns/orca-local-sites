// Worker: finds web projects, runs their dev server in a visible Orca terminal,
// watches the terminal output and answers the panel
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
import { isWebRuntime, listListeners } from './ports'
import { buildFixPrompt, DEFAULT_FIX_AGENT, isFixAgent } from './agent'
import type { Config, PortEntry, PortsState, Site, SiteStatus, SitesState } from './protocol'

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
const NOTIFY_GAP_MS = 60_000
const MAX_LIST = 500

const CONFIG_DEFAULTS: Config = {
  confirmStart: true,
  openWhenReady: false,
  notify: true,
  readyHint: true,
  autoStartAfterAgent: false,
  fixAgent: DEFAULT_FIX_AGENT
}

type Workspace = { id: string; name: string; path: string; branch: string | null; hostId: string | null; real?: string }
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
  // Favorites and hidden projects (stored), projects an agent just finished in (memory)
  const pinned = new Set<string>()
  const hidden = new Set<string>()
  const hints = new Set<string>()
  const lastNotified = new Map<string, number>()
  // The workspace the person is in right now (shown on top)
  let currentId: string | null = null

  async function getConfig(): Promise<Config> {
    const out = { ...CONFIG_DEFAULTS }
    for (const key of Object.keys(CONFIG_DEFAULTS) as (keyof Config)[]) {
      const v = await orca.settings.get(key)
      if (key === 'fixAgent') {
        if (isFixAgent(v)) out.fixAgent = v
      } else if (typeof v === 'boolean') {
        out[key] = v as never
      }
    }
    return out
  }

  /** Desktop notification, at most one per project and kind per minute, only if enabled */
  async function notify(id: string, kind: string, title: string, body: string): Promise<void> {
    if (!(await getConfig()).notify) return
    const key = `${id}:${kind}`
    if (Date.now() - (lastNotified.get(key) ?? 0) < NOTIFY_GAP_MS) return
    lastNotified.set(key, Date.now())
    await orca.host.call('notifications.show', { title, body }).catch((e) => orca.log(`notify failed: ${String(e)}`))
  }

  async function updateStatusBar(): Promise<void> {
    const active = [...sessions.values()].filter((s) => s.status === 'running')
    const withErrors = active.some((s) => s.problems.length > 0)
    const text = active.length ? `${active.length} running` : 'Sites'
    const tone = withErrors ? 'danger' : active.length ? 'success' : 'neutral'
    await orca.host
      .call('statusBar.update', { id: 'sites', text, tone, tooltip: withErrors ? 'A running site shows errors' : 'Local Sites' })
      .catch(() => undefined)
  }

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
        current: ws.id === currentId,
        pinned: pinned.has(ws.id),
        hidden: hidden.has(ws.id),
        needsInstall: info.needsInstall,
        readyHint: hints.has(ws.id) && !isActive(s),
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
    // The project you are in first, then favorites, then by name
    sites.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
    return { sites, updatedAt: Date.now() }
  }

  function publish(force = false): SitesState {
    const state = snapshot()
    const signature = JSON.stringify(state.sites)
    if (force || signature !== lastSignature) {
      lastSignature = signature
      orca.panels.post('sites.changed', state)
      void updateStatusBar()
    }
    return state
  }

  type FocusContext = { workspaceId?: string; branch: string; displayName: string; terminals: { id: string }[] } | null

  /** Which workspace is focused. The id comes with the context; if not, name and branch decide, then its terminals. */
  async function resolveCurrent(ctx: FocusContext): Promise<void> {
    let id: string | null = null
    if (ctx) {
      const branchOf = (b: string | null | undefined) => (b ?? '').replace(/^refs\/heads\//, '')
      if (ctx.workspaceId && workspaces.some((x) => x.id === ctx.workspaceId)) {
        id = ctx.workspaceId
      } else {
        const candidates = workspaces.filter((x) => x.name === ctx.displayName && branchOf(x.branch) === branchOf(ctx.branch))
        if (candidates.length === 1) {
          id = candidates[0].id
        } else if (candidates.length > 1) {
          // Several "main" workspaces: the one that owns the focused terminals
          const focused = new Set(ctx.terminals.map((t) => t.id))
          for (const c of candidates.slice(0, 20)) {
            const list = await orca.host.call('terminal.list', { workspaceId: c.id }).catch(() => null)
            if (list?.terminals.some((t) => focused.has(t.id))) {
              id = c.id
              break
            }
          }
        }
      }
    }
    if (id !== currentId) {
      currentId = id
      publish(true)
    }
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
    const list: Workspace[] = res.workspaces.filter((w) => w.hostId === null || w.hostId === LOCAL_HOST).slice(0, MAX_WORKSPACES)
    const next = new Map<string, ProjectInfo>()
    await Promise.all(
      list.map(async (w) => {
        // lsof reports resolved paths (/private/var instead of /var), so keep both
        w.real = await realpath(w.path).catch(() => w.path)
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

  const isActive = (s: Session | undefined): boolean => !!s && (s.status === 'starting' || s.status === 'running' || s.status === 'stopping')

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
    const before = { status: s.status, errors: s.problems.length > 0 }
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
    const id = [...sessions].find(([, session]) => session === s)?.[0]
    if (id) await notifyChanges(id, s, before, lines !== null)
    if (!isActive(s)) {
      await persist()
      for (const [sid, session] of sessions) if (session === s) await cleanupRunDir(sid)
    }
  }

  /** Tell the person about a crash, a failed start or new errors, once per minute at most */
  async function notifyChanges(id: string, s: Session, before: { status: SiteStatus; errors: boolean }, terminalAlive: boolean): Promise<void> {
    const ws = workspaces.find((x) => x.id === id)
    const name = ws ? siteLabel(ws.path, ws.name) : 'Project'
    if (before.status === 'running' && s.status === 'stopped' && terminalAlive) {
      await notify(id, 'crash', `${name} stopped`, 'The dev server ended unexpectedly. Open the terminal for details.')
    } else if (before.status === 'starting' && s.status === 'error') {
      await notify(id, 'fail', `${name} could not start`, s.error ?? 'See the panel for details.')
    } else if (s.status === 'running' && !before.errors && s.problems.length > 0) {
      await notify(id, 'errors', `Errors in ${name}`, s.problems[0].slice(0, 140))
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
  function start(rawId: unknown, rawPort?: unknown): Promise<SitesState> {
    const run = startChain.then(() => doStart(rawId, rawPort))
    startChain = run.catch(() => undefined)
    return run
  }

  /** A port chosen by the person: an integer in range that nothing uses */
  async function checkedPort(id: string, raw: unknown): Promise<number> {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1024 || raw > 65535) {
      throw new Error('Port must be a whole number between 1024 and 65535')
    }
    const taken = [...sessions].some(([k, s]) => k !== id && isActive(s) && s.port === raw)
    if (taken || (await isPortOpen(raw))) throw new Error(`Port ${raw} is already in use`)
    return raw
  }

  /** Look at the folder again: node_modules may exist by now, or have been removed */
  async function refreshInfo(id: string): Promise<ProjectInfo> {
    const ws = workspaces.find((w) => w.id === id)!
    const fresh = await detectProject(ws.path)
    if (fresh) projects.set(id, fresh)
    return projects.get(id)!
  }

  async function doStart(rawId: unknown, rawPort?: unknown): Promise<SitesState> {
    const id = known(rawId)
    const ws = workspaces.find((w) => w.id === id)!
    const info = await refreshInfo(id)
    hints.delete(id)
    const current = sessions.get(id)
    // Never start twice
    if (isActive(current)) return publish()
    // Close the terminal of the previous run, so they do not pile up (best effort)
    if (current?.terminalId) await orca.host.call('terminal.close', { terminalId: current.terminalId }).catch(() => undefined)
    const port = rawPort === undefined ? await freePort(id) : await checkedPort(id, rawPort)
    let terminalId: string
    try {
      ;({ terminalId } = await orca.host.call('terminal.create', {
        workspaceId: ws.id,
        title: `dev: ${ws.name}`,
        command: devCommand(info, port, info.kind === 'wordpress' ? await prepareWordPress(id, info, ws.path) : undefined)
      }))
    } catch (err) {
      // The private temp folder of a failed WordPress start must not stay behind
      await cleanupRunDir(id)
      throw err
    }
    sessions.set(id, { terminalId, port, startedAt: Date.now(), status: 'starting', error: null, log: [], history: [], snapshot: [], problems: [], timeoutMs: info.kind === 'wordpress' || info.needsInstall ? LONG_START_MS : START_TIMEOUT_MS, readyMarker: info.kind === 'wordpress' ? PLAYGROUND_READY : null, warning: null, foreignPort: null })
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
      const session: Session = { terminalId: e.terminalId, port, startedAt: Date.now(), status: 'running', error: null, log: [], history: [], snapshot: [], problems: [], timeoutMs: START_TIMEOUT_MS, readyMarker: null, warning: null, foreignPort: null }
      // The terminal must still exist, else a foreign server on that port would look like ours
      if (!(await readTerminal(session))) continue
      sessions.set(id, session)
    }
  }

  const ready = scan()
    .then(async () => {
      await resolveCurrent(await orca.host.call('workspace.readContext').catch(() => null))
    })
    .then(async () => {
      for (const key of ['pinned', 'hidden'] as const) {
        const saved = await orca.storage.get(key)
        const target = key === 'pinned' ? pinned : hidden
        if (Array.isArray(saved)) for (const v of saved.slice(0, MAX_LIST)) if (typeof v === 'string') target.add(v)
      }
    })
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
  // What a start would run, for the confirmation in the panel (nothing is written or started)
  orca.panels.handle('site.plan', async ({ id }) => {
    const known_ = known(id)
    // Same view as the start will have, so the confirmation shows what really runs
    const info = await refreshInfo(known_)
    const ws = workspaces.find((w) => w.id === known_)!
    const port = await freePort(known_)
    // WordPress runs from a private temp folder that is created at the start, its name here is a placeholder
    const preview: WordPressRun | undefined =
      info.kind === 'wordpress' ? { workDir: '/tmp/orca-local-sites-xxxxxx', project: ws.path } : undefined
    return { command: devCommand(info, port, preview), port }
  })
  orca.panels.handle('site.start', async ({ id, port }) => start(id, port))

  /** Listening ports of servers that belong to Orca: started here, or web runtimes in a listed project */
  async function scanPorts(): Promise<PortsState> {
    const listeners = await listListeners()
    const ours = new Set([...sessions.values()].filter(isActive).map((s) => s.port))
    // The workspace with the deepest folder around the program owns it. Only if that one has a row
    // in the list the port counts, so a parent folder (or a workspace that is no project) never claims what runs below.
    const owner = (cwd: string | null): Workspace | null => {
      if (!cwd) return null
      let best: Workspace | null = null
      let bestLength = -1
      for (const w of workspaces) {
        for (const root of [w.path, w.real]) {
          if (root && (cwd === root || cwd.startsWith(`${root}/`)) && root.length > bestLength) {
            best = w
            bestLength = root.length
          }
        }
      }
      return best && projects.has(best.id) ? best : null
    }
    const ports: PortEntry[] = (listeners ?? [])
      .map((l) => {
        const ws = owner(l.cwd)
        return { port: l.port, pid: l.pid, process: l.process, project: ws ? siteLabel(ws.path, ws.name) : null, projectId: ws?.id ?? null, ours: ours.has(l.port) }
      })
      // Only what belongs to Orca: servers started here, or web runtimes running in the folder of a listed project
      .filter((l) => l.port >= 1024 && (l.ours || (l.projectId && isWebRuntime(l.process))))
    return { ports, unavailable: listeners === null }
  }

  let portsCache: { at: number; state: PortsState } | null = null
  orca.panels.handle('ports.get', async () => {
    // lsof is cheap, but several open panels should not run it at the same time
    if (portsCache && Date.now() - portsCache.at < 1500) return portsCache.state
    const state = await scanPorts()
    portsCache = { at: Date.now(), state }
    return state
  })

  // Ends a dev server that runs in a project folder but was not started by this plugin (SIGTERM only)
  orca.panels.handle('site.stopExternal', async ({ id, pid, port }) => {
    const siteId = known(id)
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !Number.isInteger(port)) throw new Error('Invalid process')
    // Look again right now: the process must still be the same one, on that port, in that project, and a web runtime
    portsCache = null
    const fresh = await scanPorts()
    const match = fresh.ports.find((x) => x.pid === pid && x.port === port && x.projectId === siteId && !x.ours)
    if (!match) throw new Error('This server is no longer running in the project. Refresh the list.')
    try {
      process.kill(pid, 'SIGTERM')
    } catch (e) {
      throw new Error(`Could not stop the process: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200))
      if (!(await isPortOpen(port))) break
    }
    portsCache = null
    if (await isPortOpen(port)) throw new Error(`The process (PID ${pid}) did not end. Close it by hand.`)
    return { ok: true as const }
  })

  orca.panels.handle('config.get', async () => getConfig())
  orca.panels.handle('config.set', async (input) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid settings')
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(CONFIG_DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`)
      if (key === 'fixAgent' ? !isFixAgent(value) : typeof value !== 'boolean') throw new Error(`Invalid value for ${key}`)
      await orca.settings.set(key, value as string | boolean)
    }
    return getConfig()
  })

  orca.panels.handle('site.stop', async ({ id }) => stop(id))
  orca.panels.handle('site.show', async ({ id }) => {
    const s = sessions.get(known(id))
    if (!s?.terminalId) throw new Error('No terminal yet. Start the project first.')
    await orca.host.call('terminal.focus', { terminalId: s.terminalId })
    return { ok: true as const }
  })

  // "Fix with agent": starts an agent in the project's workspace with the errors as its task
  orca.panels.handle('site.fix', async ({ id }) => {
    const siteId = known(id)
    const s = sessions.get(siteId)
    if (!s || s.problems.length === 0) throw new Error('There are no errors to fix.')
    const ws = workspaces.find((x) => x.id === siteId)!
    const agent = (await getConfig()).fixAgent
    await orca.host.call('agent.launch', {
      workspaceId: siteId,
      agent: isFixAgent(agent) ? agent : DEFAULT_FIX_AGENT,
      prompt: buildFixPrompt(siteLabel(ws.path, ws.name), projects.get(siteId)!.label, s.problems)
    })
    return { ok: true as const }
  })

  async function saveList(key: 'pinned' | 'hidden', set: Set<string>): Promise<void> {
    await orca.storage.set(key, [...set].slice(-MAX_LIST))
  }
  orca.panels.handle('site.pin', async ({ id, pinned: value }) => {
    const siteId = known(id)
    if (typeof value !== 'boolean') throw new Error('Invalid value')
    if (value) pinned.add(siteId)
    else pinned.delete(siteId)
    await saveList('pinned', pinned)
    return publish(true)
  })
  orca.panels.handle('site.hide', async ({ id, hidden: value }) => {
    const siteId = known(id)
    if (typeof value !== 'boolean') throw new Error('Invalid value')
    if (value) hidden.add(siteId)
    else hidden.delete(siteId)
    await saveList('hidden', hidden)
    return publish(true)
  })
  orca.panels.handle('site.dismissHint', async ({ id }) => {
    hints.delete(known(id))
    return publish(true)
  })

  // An agent finished in a project that is not running: hint, notification, or start it right away
  orca.events.on('workspace.changed', async (e) => {
    await ready
    await resolveCurrent(e.context)
  })

  let lastRescan = 0
  orca.events.on('agent.status.changed', async (e) => {
    const id = e.workspaceId
    if (!id) return
    // A worktree an agent created after the last scan is not known yet: look again, at most every 5 seconds
    if (!projects.has(id) && Date.now() - lastRescan > 5000) {
      lastRescan = Date.now()
      await scan().catch((err) => orca.log(`rescan failed: ${String(err)}`))
      publish()
    }
    if (!projects.has(id)) return
    if (e.state === 'working') {
      if (hints.delete(id)) publish(true)
      return
    }
    if (e.state !== 'done' || isActive(sessions.get(id))) return
    // A failed or cancelled run is no reason to start the server by itself
    const outcome = e.mainAgent?.outcome
    const succeeded = !outcome || outcome === 'success'
    const cfg = await getConfig()
    const ws = workspaces.find((x) => x.id === id)
    const name = ws ? siteLabel(ws.path, ws.name) : 'Project'
    // A server that already runs by hand in this project must not get a second one
    const runsOutside = (await scanPorts()).ports.some((x) => x.projectId === id && !x.ours)
    if (cfg.autoStartAfterAgent && succeeded && !runsOutside) {
      const started = await start(id).then(() => true, (err) => {
        orca.log(`auto start failed: ${String(err)}`)
        return false
      })
      if (started) await notify(id, 'ready', `${name} is starting`, 'An agent finished, the dev server starts.')
    } else if (cfg.readyHint && !runsOutside) {
      hints.add(id)
      publish(true)
      await notify(id, 'ready', `${name} is ready to view`, 'An agent finished. Start the dev server in the Local Sites panel.')
    }
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
