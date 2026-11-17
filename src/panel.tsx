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
  plugin,
  read,
  Row,
  Separator,
  set,
  Skeleton,
  Stack,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import type { Site, SiteStatus, SitesState } from './protocol'

const state = atom<SitesState | null>(null)
const busy = atom<Record<string, boolean>>({})
const refreshing = atom(false)
const notice = atom('')

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

const start = (s: Site) => run(s.id, async () => set(state, await plugin.request('site.start', { id: s.id })))
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

async function refresh(): Promise<void> {
  set(refreshing, true)
  try {
    set(state, await plugin.request('sites.refresh'))
  } finally {
    set(refreshing, false)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('sites.changed', (s) => set(state, s)))
  void plugin.request('sites.get').then((s) => set(state, s))
}

function SiteRow({ s }: { s: Site }) {
  const working = !!read(busy)[s.id]
  const active = s.status === 'starting' || s.status === 'running' || s.status === 'stopping'
  const meta = [s.framework, s.branch, s.port ? `:${s.port}` : '', s.runner].filter(Boolean).join(' · ')
  return (
    <Stack gap="sm">
      <Row justify="between">
        <Text weight="semibold" truncate>
          {DOT[TONE[s.status]]} {s.name}
        </Text>
        <Badge tone={TONE[s.status]}>{LABEL[s.status]}</Badge>
      </Row>
      <Text muted size="xs" truncate>
        {meta}
      </Text>
      {s.error ? <Callout tone="danger" title="Problem">{s.error}</Callout> : null}
      {s.warning ? <Callout tone="warning" title="Could not stop">{s.warning}</Callout> : null}
      {s.problems.length && !s.error ? (
        <Collapsible title="Errors" description={s.problems.length === 1 ? '1 line' : `${s.problems.length} lines`} defaultOpen>
          <Box scroll="both" maxHeight={240}>
            <Code block>{s.problems.join('\n')}</Code>
          </Box>
        </Collapsible>
      ) : null}
      <Row gap="xs">
        {active ? (
          <Button variant="ghost" disabled={working || s.status === 'stopping'} onPress={() => stop(s)}>
            Stop
          </Button>
        ) : (
          <Button disabled={working} onPress={() => start(s)}>
            {s.status === 'error' ? 'Retry' : 'Start'}
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

export default function Panel() {
  const s = read(state)
  if (!s) return <Skeleton lines={4} label="Loading" />
  const running = s.sites.filter((x) => x.status === 'running').length
  return (
    <Stack gap="md">
      <Row justify="between">
        <Row gap="xs">
          <Heading level={3}>Local Sites</Heading>
          {running ? <Badge tone="success">{running} running</Badge> : null}
        </Row>
        <IconButton icon="refresh" label="Rescan projects" disabled={read(refreshing)} onPress={refresh} />
      </Row>
      {read(notice) ? <Callout tone="danger">{read(notice)}</Callout> : null}
      {s.sites.length === 0 ? (
        <EmptyState
          title="No web projects found"
          description="Add a project with a dev script (Next.js, Vite, Astro, Nuxt, SvelteKit, …) to Orca, then rescan."
        />
      ) : (
        s.sites.map((site, i) => (
          <Stack key={site.id} gap="md">
            {i > 0 ? <Separator /> : null}
            <SiteRow s={site} />
          </Stack>
        ))
      )}
    </Stack>
  )
}
