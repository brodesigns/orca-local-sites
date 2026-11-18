// Panel: list of web projects with start/stop, live log and browser button (no build step)
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Code,
  Collapsible,
  EmptyState,
  Heading,
  host,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Stack,
  Switch,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import { FIX_AGENTS } from './agent'
import type { Config, PortsState, Site, SiteStatus, SitesState } from './protocol'

const state = atom<SitesState | null>(null)
const busy = atom<Record<string, boolean>>({})
const refreshing = atom(false)
const notice = atom('')
const ports = atom<PortsState | null>(null)
const DEFAULT_CONFIG: Config = { confirmStart: true, openWhenReady: false, notify: true, readyHint: true, autoStartAfterAgent: false, fixAgent: 'claude' }
const config = atom<Config>(DEFAULT_CONFIG)
const showHidden = atom(false)
/** Projects started from this panel that wait for their server to be ready, to open the browser then */
const openWhenReadyFor = atom<string[]>([])
/** Neutral message, for example "ready, click Open in browser" */
const info = atom('')
/** "Start all": the projects waiting for one confirmation */
const startAllPending = atom<string[] | null>(null)
/** A stop of a server that runs outside this plugin, waiting for the person's confirmation */
const killing = atom<{ id: string; pid: number; port: number; process: string } | null>(null)
/** A start waiting for the person's confirmation: the command and the port they may change */
const pending = atom<{ id: string; command: string; plannedPort: string; port: string } | null>(null)

const TONE: Record<SiteStatus, Tone> = {
  stopped: 'neutral',
  starting: 'warning',
  running: 'success',
  stopping: 'warning',
  error: 'danger'
}
const DOT: Record<Tone, string> = { success: '🟢', danger: '🔴', warning: '🟡', accent: '🔵', neutral: '⚪' }
const LABEL: Record<SiteStatus, string> = {
  stopped: 'stopped',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  error: 'failed'
}

async function run(id: string, action: () => Promise<unknown>): Promise<void> {
  set(busy, { ...read(busy), [id]: true })
  set(notice, '')
  try {
    await action()
  } catch (err) {
    set(notice, String(err instanceof Error ? err.message : err))
  } finally {
    set(busy, { ...read(busy), [id]: false })
  }
}

const start = (s: Site) =>
  run(s.id, async () => {
    set(openWhenReadyFor, [...read(openWhenReadyFor), s.id])
    set(state, await plugin.request('site.start', { id: s.id }))
  })

const stop = (s: Site) => run(s.id, async () => set(state, await plugin.request('site.stop', { id: s.id })))
const showTerminal = (s: Site) => run(s.id, () => plugin.request('site.show', { id: s.id }))

// Must run directly from the button press (Orca requires a user gesture)
async function openInBrowser(s: Site): Promise<void> {
  if (!s.url) return
  try {
    await host.call('shell.openExternal', { url: s.url })
  } catch (err) {
    set(notice, String(err instanceof Error ? err.message : err))
  }
}

// With "Confirm before start" a click only shows the command and the port first
async function requestStart(s: Site): Promise<void> {
  if (!read(config).confirmStart) return start(s)
  await run(s.id, async () => {
    const plan = await plugin.request('site.plan', { id: s.id })
    set(pending, { id: s.id, command: plan.command, plannedPort: String(plan.port), port: String(plan.port) })
  })
}

async function confirmPending(s: Site): Promise<void> {
  const p = read(pending)
  if (!p || p.id !== s.id) return
  const port = Number(p.port.trim())
  if (!/^\d+$/.test(p.port.trim()) || !Number.isSafeInteger(port)) {
    set(notice, 'Port must be a whole number')
    return
  }
  set(pending, null)
  await run(s.id, async () => {
    set(openWhenReadyFor, [...read(openWhenReadyFor), s.id])
    set(state, await plugin.request('site.start', { id: s.id, port }))
  })
}

async function confirmKill(): Promise<void> {
  const k = read(killing)
  if (!k) return
  set(killing, null)
  await run(k.id, async () => {
    await plugin.request('site.stopExternal', { id: k.id, pid: k.pid, port: k.port })
    await loadPorts()
  })
}

async function loadPorts(): Promise<void> {
  try {
    set(ports, await plugin.request('ports.get'))
  } catch {
    // keep the last list
  }
}

async function refresh(): Promise<void> {
  set(refreshing, true)
  try {
    set(state, await plugin.request('sites.refresh'))
  } finally {
    set(refreshing, false)
  }
}

async function updateConfig(change: Partial<Config>): Promise<void> {
  set(config, { ...read(config), ...change })
  try {
    set(config, await plugin.request('config.set', change))
  } catch (err) {
    set(notice, String(err instanceof Error ? err.message : err))
  }
}

const pin = (s: Site) => run(s.id, async () => set(state, await plugin.request('site.pin', { id: s.id, pinned: !s.pinned })))
const hide = (s: Site, hidden: boolean) => run(s.id, async () => set(state, await plugin.request('site.hide', { id: s.id, hidden })))
const dismissHint = (s: Site) => run(s.id, async () => set(state, await plugin.request('site.dismissHint', { id: s.id })))
const fix = (s: Site) =>
  run(s.id, async () => {
    await plugin.request('site.fix', { id: s.id })
    set(info, `An agent (${read(config).fixAgent}) was started in ${s.name} with the errors.`)
  })

async function startAll(ids: string[]): Promise<void> {
  set(startAllPending, null)
  set(notice, '')
  for (const id of ids) {
    try {
      set(state, await plugin.request('site.start', { id }))
    } catch (err) {
      set(notice, `${read(notice)}${read(notice) ? ' ' : ''}${String(err instanceof Error ? err.message : err)}`)
    }
  }
}

async function stopAll(sites: Site[]): Promise<void> {
  set(notice, '')
  for (const s of sites) {
    try {
      set(state, await plugin.request('site.stop', { id: s.id }))
    } catch (err) {
      set(notice, `${read(notice)}${read(notice) ? ' ' : ''}${String(err instanceof Error ? err.message : err)}`)
    }
  }
}

// A server that was started from this panel is ready: try to open the browser (Orca may refuse without a fresh click)
async function openWhenReady(prev: SitesState | null, next: SitesState): Promise<void> {
  if (!read(config).openWhenReady) return
  for (const s of next.sites) {
    const waiting = read(openWhenReadyFor).includes(s.id)
    const wasRunning = prev?.sites.find((x) => x.id === s.id)?.status === 'running'
    if (!waiting || s.status !== 'running' || wasRunning || !s.url) continue
    set(openWhenReadyFor, read(openWhenReadyFor).filter((id) => id !== s.id))
    try {
      await host.call('shell.openExternal', { url: s.url })
    } catch {
      set(info, `${s.name} is ready. Click Open in browser.`)
    }
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('sites.changed', (s) => {
      const prev = read(state)
      set(state, s)
      void openWhenReady(prev, s)
    })
  )
  void plugin.request('sites.get').then((s) => set(state, s))
  void plugin.request('config.get').then((c) => set(config, c))
  void loadPorts()
  // The ports of other programs change without a signal, so look again every few seconds
  const timer = setInterval(() => void loadPorts(), 5000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

function Confirm({ s }: { s: Site }) {
  const p = read(pending)
  if (!p || p.id !== s.id) return null
  // Show what would run with the port as it is typed
  const shown = p.port.trim() ? p.command.split(p.plannedPort).join(p.port.trim()) : p.command
  return (
    <Callout tone="neutral" title="Start this project?">
      <Stack gap="sm">
        <Box scroll="both" maxHeight={120}>
          <Code block>{shown}</Code>
        </Box>
        <Input label="Port" value={p.port} maxLength={5} onChange={(port) => set(pending, { ...p, port })} onSubmit={() => confirmPending(s)} />
        <Row gap="xs">
          <Button onPress={() => confirmPending(s)}>Start</Button>
          <Button variant="ghost" onPress={() => set(pending, null)}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function PortRow({ port, process, project, ours }: { port: number; process: string; project: string | null; ours: boolean }) {
  return (
    <Row justify="between" gap="xs">
      <Row gap="xs">
        <Text weight="semibold">{`:${port}`}</Text>
        <Text muted size="xs" truncate>
          {[process, project].filter(Boolean).join(' · ')}
        </Text>
      </Row>
      <Row gap="xs">
        {ours ? <Badge tone="success">plugin</Badge> : null}
        {project || ours ? (
          <Button variant="ghost" onPress={() => host.call('shell.openExternal', { url: `http://localhost:${port}` }).catch(() => undefined)}>
            Open
          </Button>
        ) : null}
      </Row>
    </Row>
  )
}

function Ports() {
  const p = read(ports)
  if (!p) return null
  if (p.unavailable) return <Text muted size="xs">Ports cannot be listed here (lsof not available).</Text>
  const started = p.ports.filter((x) => x.ours).length
  return (
    <Collapsible
      title="Ports in use"
      description={p.ports.length ? `${p.ports.length} in your projects, ${started} started here` : 'none in your projects'}
      defaultOpen
    >
      <Stack gap="xs">
        {p.ports.length === 0 ? <Text muted size="xs">No project is listening.</Text> : null}
        {p.ports.map((x) => (
          <PortRow key={`${x.pid}:${x.port}`} {...x} />
        ))}
      </Stack>
    </Collapsible>
  )
}

function SiteRow({ s }: { s: Site }) {
  // Servers of this project that run without this plugin (for example started by hand in a terminal)
  const outside = (read(ports)?.ports ?? []).filter((x) => x.projectId === s.id && !x.ours)
  const working = !!read(busy)[s.id]
  const active = s.status === 'starting' || s.status === 'running' || s.status === 'stopping'
  // A server started by hand counts as running, as if it had been started here
  const external = outside.length > 0 && !active
  const status: SiteStatus = external ? 'running' : s.status
  const meta = [s.framework, s.branch, s.port ? `:${s.port}` : '', s.runner, external ? 'started outside this plugin' : ''].filter(Boolean).join(' · ')
  return (
    <Stack gap="sm">
      <Row justify="between">
        <Text weight="semibold" truncate>
          {DOT[TONE[status]]} {s.pinned ? '★ ' : ''}{s.name}
        </Text>
        <Row gap="xs">
          {s.current ? <Badge tone="accent">you are here</Badge> : null}
          <Badge tone={TONE[status]}>{LABEL[status]}</Badge>
          <IconButton icon="star" label={s.pinned ? 'Unpin' : 'Pin as favorite'} onPress={() => pin(s)} />
          <IconButton icon="remove" label="Hide this project" onPress={() => hide(s, true)} />
        </Row>
      </Row>
      <Text muted size="xs" truncate>
        {meta}
      </Text>
      {s.readyHint && !external ? (
        <Callout tone="success" title="Ready to view">
          <Stack gap="sm">
            <Text size="xs">An agent finished in this project.</Text>
            <Row gap="xs">
              <Button disabled={working} onPress={() => requestStart(s)}>
                {s.needsInstall ? 'Install & start' : 'Start'}
              </Button>
              <Button variant="ghost" onPress={() => dismissHint(s)}>
                Dismiss
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {s.error ? <Callout tone="danger" title="Problem">{s.error}</Callout> : null}
      {s.warning ? <Callout tone="warning" title="Could not stop">{s.warning}</Callout> : null}
      {s.problems.length && !s.error ? (
        <Collapsible title="Errors" description={s.problems.length === 1 ? '1 line' : `${s.problems.length} lines`} defaultOpen>
          <Box scroll="both" maxHeight={240}>
            <Code block>{s.problems.join('\n')}</Code>
          </Box>
          <Row gap="xs">
            <Button variant="ghost" disabled={working} onPress={() => fix(s)}>
              Fix with agent
            </Button>
          </Row>
        </Collapsible>
      ) : null}
      {external ? <ExternalServers id={s.id} servers={outside} working={working} /> : null}
      <Confirm s={s} />
      {!external ? (
        <Row gap="xs">
          {active ? (
            <Button variant="ghost" disabled={working || s.status === 'stopping'} onPress={() => stop(s)}>
              Stop
            </Button>
          ) : s.readyHint ? null : (
            <Button disabled={working || read(pending)?.id === s.id} onPress={() => requestStart(s)}>
              {s.status === 'error' ? 'Retry' : s.needsInstall ? 'Install & start' : 'Start'}
            </Button>
          )}
          {s.url ? <Button onPress={() => openInBrowser(s)}>Open in browser</Button> : null}
          {s.foreignUrl ? <Button onPress={() => openInBrowser({ ...s, url: s.foreignUrl })}>Open running server</Button> : null}
          {s.status !== 'stopped' ? (
            <Button variant="ghost" disabled={working} onPress={() => showTerminal(s)}>
              Terminal
            </Button>
          ) : null}
        </Row>
      ) : null}
      {s.log.length ? (
        <Collapsible title="Terminal output" description="last lines, raw">
          <Box scroll="both" maxHeight={240}>
            <Code block>{s.log.slice(-15).join('\n')}</Code>
          </Box>
        </Collapsible>
      ) : null}
    </Stack>
  )
}

/** Servers of a project that were started outside the plugin: open them, or stop them after a confirmation */
function ExternalServers({ id, servers, working }: { id: string; servers: PortsState['ports']; working: boolean }) {
  const k = read(killing)
  return (
    <Stack gap="xs">
      {servers.map((x) => (
        <Stack key={`${x.pid}:${x.port}`} gap="xs">
          <Row justify="between" gap="xs">
            <Text size="xs" truncate>
              {`:${x.port} · ${x.process} · PID ${x.pid}`}
            </Text>
            <Row gap="xs">
              <Button onPress={() => host.call('shell.openExternal', { url: `http://localhost:${x.port}` }).catch(() => undefined)}>
                Open in browser
              </Button>
              <Button
                variant="ghost"
                disabled={working}
                onPress={() => set(killing, { id, pid: x.pid, port: x.port, process: x.process })}
              >
                Stop
              </Button>
            </Row>
          </Row>
          {k && k.id === id && k.pid === x.pid && k.port === x.port ? (
            <Callout tone="warning" title="Stop this server?">
              <Stack gap="sm">
                <Text size="xs">{`${x.process} (PID ${x.pid}) on :${x.port} was not started by this plugin. It gets a normal stop signal.`}</Text>
                <Row gap="xs">
                  <Button onPress={confirmKill}>Stop server</Button>
                  <Button variant="ghost" onPress={() => set(killing, null)}>
                    Cancel
                  </Button>
                </Row>
              </Stack>
            </Callout>
          ) : null}
        </Stack>
      ))}
    </Stack>
  )
}

function SettingsBox() {
  const c = read(config)
  return (
    <Collapsible title="Settings" description="start, notifications, agent">
      <Stack gap="sm">
        <Switch label="Confirm before start" checked={c.confirmStart} onChange={(v) => updateConfig({ confirmStart: v })} />
        <Switch label="Open in browser when ready" checked={c.openWhenReady} onChange={(v) => updateConfig({ openWhenReady: v })} />
        <Switch label="Notify on crash or errors" checked={c.notify} onChange={(v) => updateConfig({ notify: v })} />
        <Switch label="Hint when an agent finished" checked={c.readyHint} onChange={(v) => updateConfig({ readyHint: v })} />
        <Switch
          label="Start right after an agent finished"
          checked={c.autoStartAfterAgent}
          onChange={(v) => updateConfig({ autoStartAfterAgent: v })}
        />
        <Select
          label="Agent for Fix with agent"
          value={c.fixAgent}
          options={FIX_AGENTS.map((a) => ({ value: a, label: a }))}
          onChange={(v) => updateConfig({ fixAgent: v })}
        />
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const s = read(state)
  if (!s) return <Skeleton lines={4} label="Loading" />
  const outsideIds = new Set((read(ports)?.ports ?? []).filter((x) => !x.ours && x.projectId).map((x) => x.projectId))
  // same rule as in the row: a server outside the plugin counts unless the plugin runs this project itself
  const outside = (x: Site) => outsideIds.has(x.id) && !(x.status === 'starting' || x.status === 'running' || x.status === 'stopping')
  const running = s.sites.filter((x) => x.status === 'running' || outside(x)).length
  const visible = s.sites.filter((x) => !x.hidden || read(showHidden))
  const hiddenCount = s.sites.filter((x) => x.hidden).length
  // Start all: every visible project that is stopped and not running elsewhere. Stop all: only what this plugin started.
  const startable = s.sites.filter((x) => !x.hidden && (x.status === 'stopped' || x.status === 'error') && !outside(x))
  const stoppable = s.sites.filter((x) => x.status === 'starting' || x.status === 'running')
  const pendingAll = read(startAllPending)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Row gap="xs">
          <Heading level={3}>Local Sites</Heading>
          {running ? <Badge tone="success">{running} running</Badge> : null}
        </Row>
        <Row gap="xs">
          <IconButton icon="play" label="Start all" disabled={startable.length === 0} onPress={() => set(startAllPending, startable.map((x) => x.id))} />
          <IconButton icon="stop" label="Stop all" disabled={stoppable.length === 0} onPress={() => stopAll(stoppable)} />
          <IconButton icon="refresh" label="Rescan projects" disabled={read(refreshing)} onPress={refresh} />
        </Row>
      </Row>
      {pendingAll ? (
        <Callout tone="neutral" title={`Start ${pendingAll.length} projects?`}>
          <Stack gap="sm">
            <Text size="xs">{pendingAll.map((id) => s.sites.find((x) => x.id === id)?.name).filter(Boolean).join(', ')}</Text>
            <Row gap="xs">
              <Button onPress={() => startAll(pendingAll)}>Start all</Button>
              <Button variant="ghost" onPress={() => set(startAllPending, null)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {read(notice) ? <Callout tone="danger">{read(notice)}</Callout> : null}
      {read(info) ? (
        <Callout tone="success">
          <Row justify="between">
            <Text size="xs">{read(info)}</Text>
            <Button variant="ghost" onPress={() => set(info, '')}>
              OK
            </Button>
          </Row>
        </Callout>
      ) : null}
      <Ports />
      {s.sites.length === 0 ? (
        <EmptyState
          title="No web projects found"
          description="Add a project with a dev script (Next.js, Vite, Astro, Nuxt, SvelteKit, …) to Orca, then rescan."
        />
      ) : (
        visible.map((site, i) => (
          <Stack key={site.id} gap="md">
            {i > 0 ? <Separator /> : null}
            <SiteRow s={site} />
            {site.hidden ? (
              <Button variant="ghost" onPress={() => hide(site, false)}>
                Show this project again
              </Button>
            ) : null}
          </Stack>
        ))
      )}
      {hiddenCount ? (
        <Button variant="ghost" onPress={() => set(showHidden, !read(showHidden))}>
          {read(showHidden) ? 'Hide hidden projects' : `Show hidden projects (${hiddenCount})`}
        </Button>
      ) : null}
      <Separator />
      <SettingsBox />
    </Stack>
  )
}
