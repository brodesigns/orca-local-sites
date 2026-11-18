import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Site, SitesState } from './protocol'

// Unmount even when an assertion fails: the panel's polling timer would keep node alive
const views: { unmount(): Promise<void> }[] = []
async function open(host: ReturnType<typeof mockHost>) {
  const v = await mount(panel, { host })
  views.push(v)
  return v
}
function t(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    try {
      await fn()
    } finally {
      for (const v of views.splice(0)) await v.unmount().catch(() => undefined)
    }
  })
}

const cfg = { confirmStart: true, openWhenReady: false, notify: true, readyHint: true, autoStartAfterAgent: false, fixAgent: 'claude' }

const site: Site = {
  id: 'w1', name: 'acme-shop', branch: 'main', runner: 'pnpm', framework: 'Next.js', status: 'stopped',
  port: null, url: null, error: null, warning: null, foreignUrl: null, hasErrors: false, problems: [], log: [],
  current: false, pinned: false, hidden: false, needsInstall: false, readyHint: false
}
const running: Site = { ...site, status: 'running', port: 3201, url: 'http://localhost:3201', log: ['Ready'] }

t('start runs the worker, the browser button opens the site url', async () => {
  let current: SitesState = { sites: [site], updatedAt: 1 }
  const host = mockHost({
    requests: {
      'sites.get': () => current,
      'config.get': { ...cfg, confirmStart: false },
      'ports.get': { ports: [], unavailable: false },
      'site.start': () => (current = { sites: [running], updatedAt: 2 })
    },
    results: { 'shell.openExternal': { opened: true } }
  })
  const view = await open(host)
  assert.equal(view.find({ text: 'Open in browser' }), null)
  await view.press({ text: 'Start' })
  await view.press({ text: 'Open in browser' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: 'http://localhost:3201' }])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

t('shows an empty state without projects', async () => {
  const host = mockHost({
    requests: { 'sites.get': { sites: [], updatedAt: 1 }, 'config.get': cfg, 'ports.get': { ports: [], unavailable: false } }
  })
  const view = await open(host)
  assert.ok(view.find({ type: 'EmptyState' }))
  await view.unmount()
})

t('with confirmation on, Start shows the command and the chosen port is used', async () => {
  const started: unknown[] = []
  const host = mockHost({
    requests: {
      'sites.get': { sites: [site], updatedAt: 1 },
      'config.get': cfg,
      'ports.get': { ports: [{ port: 3000, pid: 1, process: 'node', project: 'acme-docs', projectId: 'w9', ours: false }], unavailable: false },
      'site.plan': { command: 'PORT=3201 pnpm dev', port: 3201 },
      'site.start': (input) => {
        started.push(input)
        return { sites: [running], updatedAt: 2 }
      }
    }
  })
  const view = await open(host)
  // other ports are listed above the projects
  assert.ok(view.find({ text: /:3000/ }))
  await view.press({ text: 'Start' })
  // nothing started yet, the command is shown for confirmation
  assert.deepEqual(started, [])
  assert.ok(view.find({ text: /PORT=3201 pnpm dev/ }))
  assert.ok(view.find({ text: /PORT=3201 pnpm dev/ }))
  await view.type({ label: 'Port' }, '3217', { replace: true, submit: true })
  assert.deepEqual(started, [{ id: 'w1', port: 3217 }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

t('a server started outside the plugin counts as running: no Start, but Open and a confirmed Stop', async () => {
  let stopped: unknown = null
  const host = mockHost({
    requests: {
      'sites.get': { sites: [site], updatedAt: 1 },
      'config.get': cfg,
      'ports.get': { ports: [{ port: 3000, pid: 7, process: 'node', project: 'acme-shop', projectId: 'w1', ours: false }], unavailable: false },
      'site.stopExternal': (input) => {
        stopped = input
        return { ok: true }
      }
    },
    results: { 'shell.openExternal': { opened: true } }
  })
  const view = await open(host)
  // shown as running, there is no Start button for it
  assert.ok(view.find({ text: 'running' }))
  assert.equal(view.find({ text: 'Start' }), null)
  assert.ok(view.find({ text: /:3000 · node · PID 7/ }))
  await view.press({ text: 'Open in browser' })
  assert.deepEqual(host.callsOf('shell.openExternal')[0], { url: 'http://localhost:3000' })
  // Stop asks first, nothing is stopped before the confirmation
  await view.press({ text: 'Stop' })
  assert.equal(stopped, null)
  assert.ok(view.find({ text: /was not started by this plugin/ }))
  await view.press({ text: 'Stop server' })
  assert.deepEqual(stopped, { id: 'w1', pid: 7, port: 3000 })
  assert.deepEqual(view.errors, [])
})

t('cancelling the stop of an outside server keeps it running', async () => {
  let stopped = false
  const host = mockHost({
    requests: {
      'sites.get': { sites: [site], updatedAt: 1 },
      'config.get': cfg,
      'ports.get': { ports: [{ port: 3000, pid: 7, process: 'node', project: 'acme-shop', projectId: 'w1', ours: false }], unavailable: false },
      'site.stopExternal': () => {
        stopped = true
        return { ok: true }
      }
    }
  })
  const view = await open(host)
  await view.press({ text: 'Stop' })
  await view.press({ text: 'Cancel' })
  assert.equal(stopped, false)
  assert.equal(view.find({ text: /was not started by this plugin/ }), null)
})

t('the running counter includes a failed project that runs outside the plugin', async () => {
  const failed: Site = { ...site, status: 'error', error: 'Another dev server is already running' }
  const host = mockHost({
    requests: {
      'sites.get': { sites: [failed], updatedAt: 1 },
      'config.get': cfg,
      'ports.get': { ports: [{ port: 3000, pid: 7, process: 'node', project: 'acme-shop', projectId: 'w1', ours: false }], unavailable: false }
    }
  })
  const view = await open(host)
  assert.ok(view.find({ text: '1 running' }))
})
