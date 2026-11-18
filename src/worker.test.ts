import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { isPortOpen } from './worker'

// Every test stops its workers, even when an assertion fails (a live worker timer keeps node running)
const workers: { deactivate(): Promise<void> }[] = []
type Worker = Awaited<ReturnType<typeof mountWorker>>
async function mount(host: ReturnType<typeof mockHost>): Promise<Worker> {
  const w = await mountWorker(main, { host })
  workers.push(w)
  return w
}
function t(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    try {
      await fn()
    } finally {
      for (const w of workers.splice(0)) await w.deactivate().catch(() => undefined)
    }
  })
}

async function nextProject(fresh = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-sites-'))
  // dependencies are installed, unless this is a fresh worktree
  if (!fresh) await mkdir(join(dir, 'node_modules'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '16' }, scripts: { dev: 'next dev' } }))
  await writeFile(join(dir, 'pnpm-lock.yaml'), '')
  return dir
}

t('starts a dev server in a terminal, detects ready and stops it', async () => {
  const dir = await nextProject()
  const plain = await mkdtemp(join(tmpdir(), 'local-sites-'))
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'shop', path: dir, branch: 'main', hostId: null },
          { id: 'w2', kind: 'folder', name: 'notes', path: plain, branch: null, hostId: 'local' },
          { id: 'w3', kind: 'folder', name: 'remote', path: dir, branch: null, hostId: 'ssh-1' }
        ],
        truncated: false
      },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: ['  ▲ Next.js 16', '  - Local: http://localhost:3999'], truncated: false },
      'terminal.focus': { focused: true },
      'terminal.close': { closed: true }
    }
  })
  const worker = await mount(host)
  const first = (await worker.request('sites.get')) as { sites: { id: string; status: string; runner: string }[] }
  // Only the local Next.js project is listed
  assert.deepEqual(first.sites.map((s) => [s.id, s.status, s.runner]), [['w1', 'stopped', 'pnpm']])

  const started = (await worker.request('site.start', { id: 'w1' })) as { sites: { status: string; port: number }[] }
  assert.equal(started.sites[0].status, 'starting')
  const create = host.callsOf('terminal.create')[0] as { command: string; workspaceId: string }
  assert.equal(create.workspaceId, 'w1')
  assert.match(create.command, /^PORT=\d+ pnpm dev$/)

  assert.deepEqual(await worker.request('site.show', { id: 'w1' }), { ok: true })
  assert.deepEqual(host.callsOf('terminal.focus'), [{ terminalId: 't1' }])

  // Second start does not open a second terminal
  await worker.request('site.start', { id: 'w1' })
  assert.equal(host.callsOf('terminal.create').length, 1)

  // The server answers on the port the terminal printed
  const server = createServer()
  await new Promise<void>((r) => server.listen(3999, '127.0.0.1', r))
  try {
    const running = (await worker.request('sites.refresh')) as { sites: { status: string; url: string | null }[] }
    assert.equal(running.sites[0].status, 'running')
    assert.equal(running.sites[0].url, 'http://localhost:3999')

    const stopping = (await worker.request('site.stop', { id: 'w1' })) as { sites: { status: string }[] }
    assert.equal(stopping.sites[0].status, 'stopping')
    assert.deepEqual(host.callsOf('terminal.close')[0], { terminalId: 't1' })
  } finally {
    await new Promise((r) => server.close(r))
  }
  const stopped = (await worker.request('sites.refresh')) as { sites: { status: string }[] }
  assert.equal(stopped.sites[0].status, 'stopped')
  await worker.request('site.start', { id: 'w1' })
  assert.equal(host.callsOf('terminal.create').length, 2)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

t('refuses unknown or invalid project ids', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mount(host)
  await assert.rejects(worker.request('site.start', { id: 'nope' }))
  await assert.rejects(worker.request('site.stop', { id: 42 as unknown as string }))
  await assert.rejects(worker.request('site.show', { id: '../etc' }))
  await assert.rejects(worker.request('site.show', { id: 'w1' }))
  assert.equal(host.callsOf('terminal.create').length, 0)
  await worker.deactivate()
})

t('a failing start shows the error line', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: ['Error: listen EADDRINUSE: address already in use'], truncated: false }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  await worker.request('site.start', { id: 'w1' })
  const s = (await worker.request('sites.refresh')) as { sites: { status: string; error: string | null }[] }
  assert.equal(s.sites[0].status, 'error')
  assert.match(s.sites[0].error ?? '', /EADDRINUSE/)
  await worker.deactivate()
})

t('a port conflict is an error even if a foreign server answers on the port', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: ['Error: listen EADDRINUSE: address already in use'], truncated: false }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const started = (await worker.request('site.start', { id: 'w1' })) as { sites: { port: number }[] }
  const port = started.sites[0].port
  const foreign = createServer()
  await new Promise<void>((r) => foreign.listen(port, '127.0.0.1', r))
  try {
    const s = (await worker.request('sites.refresh')) as { sites: { status: string; url: string | null }[] }
    assert.equal(s.sites[0].status, 'error')
    assert.equal(s.sites[0].url, null)
  } finally {
    await new Promise((r) => foreign.close(r))
    await worker.deactivate()
  }
})

t('two starts at once get different ports', async () => {
  const a = await nextProject()
  const b = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'folder', name: 'a', path: a, branch: null, hostId: null },
          { id: 'w2', kind: 'folder', name: 'b', path: b, branch: null, hostId: null }
        ],
        truncated: false
      },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: [], truncated: false }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  await Promise.all([worker.request('site.start', { id: 'w1' }), worker.request('site.start', { id: 'w2' })])
  const ports = host.callsOf('terminal.create').map((c) => (c as { command: string }).command.match(/PORT=(\d+)/)?.[1])
  assert.equal(ports.length, 2)
  assert.notEqual(ports[0], ports[1])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

t('a WordPress project runs from a private folder with a blueprint for the plugins it needs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-sites-'))
  await writeFile(join(dir, 'shop.php'), '<?php\n/*\n * Plugin Name: Shop\n * Requires Plugins: woocommerce\n */')
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: [], truncated: false }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  await worker.request('site.start', { id: 'w1' })
  const command = (host.callsOf('terminal.create')[0] as { command: string }).command
  const m = /^cd '([^']+)' && npx .* --auto-mount='([^']+)' --login --port \d+ --blueprint (\S+)$/.exec(command)
  assert.ok(m)
  const [, workDir, project, file] = m
  // npx starts in a private empty folder, the project is only mounted
  assert.ok(!workDir.startsWith(dir))
  assert.equal(project, dir)
  assert.equal(file, join(workDir, 'blueprint.json'))
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).steps[0].pluginData.slug, 'woocommerce')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

t('an already running dev server of the project is reported with its address', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': {
        lines: ['⨯ Another next dev server is already running.', '', '- Local:        http://localhost:3000', '- PID:          53095'],
        truncated: false
      }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  await worker.request('site.start', { id: 'w1' })
  const s = (await worker.request('sites.refresh')) as { sites: { status: string; url: string | null; foreignUrl: string | null; port: number }[] }
  assert.equal(s.sites[0].status, 'error')
  // the foreign server is never taken over as our own
  assert.equal(s.sites[0].url, null)
  assert.equal(s.sites[0].foreignUrl, 'http://localhost:3000')
  assert.notEqual(s.sites[0].port, 3000)
})

t('a closed terminal with a busy port is an error, and stop accepts a terminal that is gone', async () => {
  const dir = await nextProject()
  let gone = false
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': () => {
        if (gone) throw hostError('action_failed', 'terminal not found')
        return { lines: ['Local: http://localhost:3997'], truncated: false }
      },
      'terminal.close': () => {
        throw hostError('action_failed', 'terminal not found')
      }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const started = (await worker.request('site.start', { id: 'w1' })) as { sites: { port: number }[] }
  const server = createServer()
  await new Promise<void>((r) => server.listen(started.sites[0].port, '127.0.0.1', r))
  try {
    await worker.request('sites.refresh')
    gone = true
    const s = (await worker.request('sites.refresh')) as { sites: { status: string; error: string | null }[] }
    assert.equal(s.sites[0].status, 'error')
    assert.match(s.sites[0].error ?? '', /port is still in use/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

t('restore skips broken storage entries and keeps the valid ones', async () => {
  const dir = await nextProject()
  const host = mockHost({
    storage: { sessions: { w0: null, w9: 'x', w1: { terminalId: 't1', port: 99999999 } } },
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false }
    }
  })
  const worker = await mount(host)
  const s = (await worker.request('sites.get')) as { sites: { status: string }[] }
  assert.equal(s.sites[0].status, 'stopped')
})

t('stop reports an error and keeps the status when the terminal cannot be closed', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: ['Local: http://localhost:3998'], truncated: false },
      'terminal.close': () => {
        throw hostError('action_failed', 'terminal is outside the active worktree')
      }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const started = (await worker.request('site.start', { id: 'w1' })) as { sites: { port: number }[] }
  const server = createServer()
  await new Promise<void>((r) => server.listen(started.sites[0].port, '127.0.0.1', r))
  try {
    await worker.request('sites.refresh')
    await assert.rejects(worker.request('site.stop', { id: 'w1' }), /Could not stop/)
    const s = (await worker.request('sites.get')) as { sites: { status: string }[] }
    assert.equal(s.sites[0].status, 'running')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

t('a port chosen in the panel is checked and used', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: [], truncated: false }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const plan = (await worker.request('site.plan', { id: 'w1' })) as { command: string; port: number }
  assert.equal(plan.command, `PORT=${plan.port} pnpm dev`)
  assert.equal(host.callsOf('terminal.create').length, 0)
  // invalid ports are refused before anything starts
  for (const bad of [80, 70000, 3000.5, '3300' as unknown as number]) {
    await assert.rejects(worker.request('site.start', { id: 'w1', port: bad }))
  }
  // a port that something else holds is refused
  const busy = createServer()
  await new Promise<void>((r) => busy.listen(3881, '127.0.0.1', r))
  try {
    await assert.rejects(worker.request('site.start', { id: 'w1', port: 3881 }), /already in use/)
  } finally {
    await new Promise((r) => busy.close(r))
  }
  assert.equal(host.callsOf('terminal.create').length, 0)
  await worker.request('site.start', { id: 'w1', port: 3882 })
  assert.equal((host.callsOf('terminal.create')[0] as { command: string }).command, 'PORT=3882 pnpm dev')
})

t('ports.get lists only ports of programs in listed projects and marks the ones this plugin started', async () => {
  const dir = await nextProject()
  const elsewhere = await mkdtemp(join(tmpdir(), 'local-sites-other-'))
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }],
        truncated: false
      },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: [], truncated: false }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  // Real programs: one runs in the project folder, one somewhere else (like a database or a tool)
  const listen = (port: number, cwd: string) =>
    spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'127.0.0.1')`], { cwd, stdio: 'ignore' })
  const inProject = listen(3883, dir)
  const outside = listen(3884, elsewhere)
  try {
    for (let i = 0; i < 50 && !(await isPortOpen(3883) && (await isPortOpen(3884))); i++) await new Promise((r) => setTimeout(r, 100))
    const res = (await worker.request('ports.get')) as { ports: { port: number; projectId: string | null; ours: boolean }[]; unavailable: boolean }
    assert.equal(res.unavailable, false)
    assert.ok(res.ports.find((p) => p.port === 3883 && p.projectId === 'w1'))
    // a program outside the listed projects is not shown, nor is anything else on the machine
    assert.equal(res.ports.find((p) => p.port === 3884), undefined)
    assert.ok(res.ports.every((p) => p.ours || p.projectId))
  } finally {
    inProject.kill()
    outside.kill()
  }
})

t('the confirm setting defaults to on and only accepts booleans', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mount(host)
  const defaults = { confirmStart: true, openWhenReady: false, notify: true, readyHint: true, autoStartAfterAgent: false, fixAgent: 'claude' }
  assert.deepEqual(await worker.request('config.get'), defaults)
  assert.deepEqual(await worker.request('config.set', { confirmStart: false }), { ...defaults, confirmStart: false })
  assert.deepEqual(await worker.request('config.get'), { ...defaults, confirmStart: false })
  await assert.rejects(worker.request('config.set', { confirmStart: 'no' as unknown as boolean }))
})

t('a server that runs outside the plugin can be stopped, but only the right process in the right project', async () => {
  const dir = await nextProject()
  const elsewhere = await mkdtemp(join(tmpdir(), 'local-sites-other-'))
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'shop', path: dir, branch: null, hostId: null }], truncated: false }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const listen = (port: number, cwd: string) =>
    spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'127.0.0.1')`], { cwd, stdio: 'ignore' })
  const mine = listen(3886, dir)
  const other = listen(3887, elsewhere)
  try {
    for (let i = 0; i < 50 && !((await isPortOpen(3886)) && (await isPortOpen(3887))); i++) await new Promise((r) => setTimeout(r, 100))
    // refused: unknown project, wrong pid/port pairs, a program outside the project, our own process, pid 1
    await assert.rejects(worker.request('site.stopExternal', { id: 'nope', pid: mine.pid!, port: 3886 }))
    await assert.rejects(worker.request('site.stopExternal', { id: 'w1', pid: mine.pid!, port: 3887 }))
    await assert.rejects(worker.request('site.stopExternal', { id: 'w1', pid: other.pid!, port: 3887 }))
    await assert.rejects(worker.request('site.stopExternal', { id: 'w1', pid: process.pid, port: 3886 }))
    await assert.rejects(worker.request('site.stopExternal', { id: 'w1', pid: 1, port: 3886 }))
    await assert.rejects(worker.request('site.stopExternal', { id: 'w1', pid: '12' as unknown as number, port: 3886 }))
    assert.equal(await isPortOpen(3886), true)
    assert.equal(await isPortOpen(3887), true)
    // allowed: the server in the project folder
    assert.deepEqual(await worker.request('site.stopExternal', { id: 'w1', pid: mine.pid!, port: 3886 }), { ok: true })
    assert.equal(await isPortOpen(3886), false)
    // the other program was not touched
    assert.equal(await isPortOpen(3887), true)
  } finally {
    mine.kill()
    other.kill()
  }
})

const WS = (id: string, path: string) => ({ id, kind: 'folder', name: id, path, branch: null, hostId: null })

t('a fresh worktree without node_modules installs first, and only once', async () => {
  const dir = await nextProject(true)
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [WS('w1', dir)], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: [], truncated: false },
      'terminal.close': { closed: true }
    }
  })
  const worker = await mount(host)
  const first = (await worker.request('sites.get')) as { sites: { needsInstall: boolean }[] }
  assert.equal(first.sites[0].needsInstall, true)
  const plan = (await worker.request('site.plan', { id: 'w1' })) as { command: string; port: number }
  assert.equal(plan.command, `pnpm install && PORT=${plan.port} pnpm dev`)
  await worker.request('site.start', { id: 'w1' })
  assert.match((host.callsOf('terminal.create')[0] as { command: string }).command, /^pnpm install && PORT=\d+ pnpm dev$/)
  // after the install node_modules exists: the next start does not install again
  await mkdir(join(dir, 'node_modules'))
  await worker.request('site.stop', { id: 'w1' })
  await worker.request('sites.refresh')
  await worker.request('site.start', { id: 'w1' })
  assert.match((host.callsOf('terminal.create')[1] as { command: string }).command, /^PORT=\d+ pnpm dev$/)
})

t('Fix with agent launches the configured agent with the errors, and only when there are errors', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [WS('w1', dir)], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: ['⨯ Failed to compile', './app/page.tsx', "Module not found: Can't resolve './hero'"], truncated: false },
      'agent.launch': { terminalId: 'a1' }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  await assert.rejects(worker.request('site.fix', { id: 'w1' }), /no errors/i)
  await worker.request('site.start', { id: 'w1' })
  await worker.request('sites.refresh')
  await worker.request('site.fix', { id: 'w1' })
  const call = host.callsOf('agent.launch')[0] as { workspaceId: string; agent: string; prompt: string }
  assert.equal(call.workspaceId, 'w1')
  assert.equal(call.agent, 'claude')
  assert.ok(call.prompt.includes('Failed to compile'))
  // another agent from the settings, unknown ones are refused
  await worker.request('config.set', { fixAgent: 'codex' })
  await worker.request('site.fix', { id: 'w1' })
  assert.equal((host.callsOf('agent.launch')[1] as { agent: string }).agent, 'codex')
  await assert.rejects(worker.request('config.set', { fixAgent: 'rm -rf /' as never }))
  await assert.rejects(worker.request('config.set', { nope: true } as never))
  await assert.rejects(worker.request('site.fix', { id: 'unknown' }))
})

t('favorites and hidden projects are stored and come back after a restart', async () => {
  const a = await nextProject()
  const b = await nextProject()
  const list = { workspaces: [WS('a', a), WS('b', b)], truncated: false }
  const host = mockHost({ results: { 'workspace.list': list } })
  const worker = await mount(host)
  await worker.request('sites.get')
  await worker.request('site.pin', { id: 'b', pinned: true })
  await worker.request('site.hide', { id: 'a', hidden: true })
  const s = (await worker.request('sites.get')) as { sites: { id: string; pinned: boolean; hidden: boolean }[] }
  // favorites come first
  assert.deepEqual(s.sites.map((x) => [x.id, x.pinned, x.hidden]), [['b', true, false], ['a', false, true]])
  await assert.rejects(worker.request('site.pin', { id: 'zzz', pinned: true }))
  await assert.rejects(worker.request('site.hide', { id: 'a', hidden: 'yes' as never }))
  // new worker on the same storage
  const again = await mount(mockHost({ storage: host.data().storage as Record<string, never>, results: { 'workspace.list': list } }))
  const s2 = (await again.request('sites.get')) as { sites: { id: string; pinned: boolean; hidden: boolean }[] }
  assert.deepEqual(s2.sites.map((x) => [x.id, x.pinned, x.hidden]), [['b', true, false], ['a', false, true]])
})

t('an agent that finishes in a stopped project gives a hint and a notification, and the hint goes away', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [WS('w1', dir)], truncated: false },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const event = (state: 'working' | 'done', workspaceId: string | null) => ({ workspaceId, paneKey: 'p', state, receivedAt: Date.now() })
  // unknown project or no workspace: nothing happens
  await worker.emit('agent.status.changed', event('done', 'other'))
  await worker.emit('agent.status.changed', event('done', null))
  assert.equal(host.callsOf('notifications.show').length, 0)
  await worker.emit('agent.status.changed', event('done', 'w1'))
  const hint = (await worker.request('sites.get')) as { sites: { readyHint: boolean }[] }
  assert.equal(hint.sites[0].readyHint, true)
  assert.match((host.callsOf('notifications.show')[0] as { title: string }).title, /ready to view/)
  // the agent works again: the hint goes away
  await worker.emit('agent.status.changed', event('working', 'w1'))
  assert.equal(((await worker.request('sites.get')) as { sites: { readyHint: boolean }[] }).sites[0].readyHint, false)
  // switched off in the settings: no hint
  await worker.request('config.set', { readyHint: false })
  await worker.emit('agent.status.changed', event('done', 'w1'))
  assert.equal(((await worker.request('sites.get')) as { sites: { readyHint: boolean }[] }).sites[0].readyHint, false)
})

t('after an agent finished the project starts by itself when that is switched on', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [WS('w1', dir)], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: [], truncated: false },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const done = { workspaceId: 'w1', paneKey: 'p', state: 'done' as const, receivedAt: Date.now() }
  await worker.emit('agent.status.changed', done)
  assert.equal(host.callsOf('terminal.create').length, 0)
  await worker.request('config.set', { autoStartAfterAgent: true })
  await worker.emit('agent.status.changed', done)
  assert.equal(host.callsOf('terminal.create').length, 1)
})

t('a crash and new errors are announced once, and the status bar counts running servers', async () => {
  const dir = await nextProject()
  let lines = ['Local: http://localhost:3995']
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [WS('w1', dir)], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': () => ({ lines, truncated: false }),
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const started = (await worker.request('site.start', { id: 'w1' })) as { sites: { port: number }[] }
  const server = createServer()
  await new Promise<void>((r) => server.listen(started.sites[0].port, '127.0.0.1', r))
  try {
    await worker.request('sites.refresh')
    assert.equal(host.callsOf('notifications.show').length, 0)
    // new errors while running
    lines = [...lines, ' ⨯ Failed to compile', './app/page.tsx']
    await worker.request('sites.refresh')
    const titles = () => host.callsOf('notifications.show').map((c) => (c as { title: string }).title)
    assert.equal(titles().length, 1)
    assert.match(titles()[0], /^Errors in /)
    // the status bar shows the running server with errors
    const bar = host.callsOf('statusBar.update').at(-1) as { text: string; tone: string }
    assert.deepEqual([bar.text, bar.tone], ['1 running', 'danger'])
    // the server ends while its terminal is still open: a crash
    await new Promise((r) => server.close(r))
    await worker.request('sites.refresh')
    assert.equal(titles().length, 2)
    assert.match(titles()[1], / stopped$/)
    // switched off: nothing more
    await worker.request('config.set', { notify: false })
    assert.equal(host.callsOf('notifications.show').length, 2)
  } finally {
    server.close()
  }
})

const listenIn = (port: number, cwd: string) =>
  spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'127.0.0.1')`], { cwd, stdio: 'ignore' })
const waitOpen = async (port: number) => {
  for (let i = 0; i < 50 && !(await isPortOpen(port)); i++) await new Promise((r) => setTimeout(r, 100))
}
const done = (workspaceId: string | null, outcome?: 'success' | 'failure') => ({
  workspaceId,
  paneKey: 'p',
  state: 'done' as const,
  receivedAt: Date.now(),
  ...(outcome ? { mainAgent: { state: 'done' as const, outcome, stateStartedAt: 1 } } : {})
})

t('a worktree that appears after the scan is found when its agent finishes', async () => {
  const dir = await nextProject()
  let list: unknown[] = []
  const host = mockHost({
    results: {
      'workspace.list': () => ({ workspaces: list, truncated: false }),
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mount(host)
  assert.equal(((await worker.request('sites.get')) as { sites: unknown[] }).sites.length, 0)
  list = [WS('w1', dir)]
  await worker.emit('agent.status.changed', done('w1'))
  const s = (await worker.request('sites.get')) as { sites: { id: string; readyHint: boolean }[] }
  assert.deepEqual(s.sites.map((x) => [x.id, x.readyHint]), [['w1', true]])
})

t('auto start skips failed agent runs, running servers and reports only real starts', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [WS('w1', dir)], truncated: false },
      'terminal.create': { terminalId: 't1' },
      'terminal.read': { lines: [], truncated: false },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  await worker.request('config.set', { autoStartAfterAgent: true })
  // a failed run: only the hint, no start
  await worker.emit('agent.status.changed', done('w1', 'failure'))
  assert.equal(host.callsOf('terminal.create').length, 0)
  // a server that runs by hand in the project: no second server, no hint
  const manual = listenIn(3891, dir)
  try {
    await waitOpen(3891)
    await worker.emit('agent.status.changed', done('w1', 'success'))
    assert.equal(host.callsOf('terminal.create').length, 0)
  } finally {
    manual.kill()
  }
  await new Promise((r) => setTimeout(r, 300))
  await worker.emit('agent.status.changed', done('w1', 'success'))
  assert.equal(host.callsOf('terminal.create').length, 1)
})

t('a failed auto start is not announced as starting', async () => {
  const dir = await nextProject()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [WS('w1', dir)], truncated: false },
      'terminal.create': () => {
        throw hostError('action_failed', 'no terminal')
      },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  await worker.request('config.set', { autoStartAfterAgent: true })
  await worker.emit('agent.status.changed', done('w1', 'success'))
  assert.equal(host.callsOf('notifications.show').length, 0)
})

t('the confirmation shows what the start will really run', async () => {
  const dir = await nextProject(true)
  const host = mockHost({ results: { 'workspace.list': { workspaces: [WS('w1', dir)], truncated: false } } })
  const worker = await mount(host)
  await worker.request('sites.get')
  // installed after the last scan
  await mkdir(join(dir, 'node_modules'))
  const plan = (await worker.request('site.plan', { id: 'w1' })) as { command: string }
  assert.ok(!/install/.test(plan.command))
})

t('a parent folder or a workspace without a row never claims programs below it', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'local-sites-parent-'))
  await writeFile(join(parent, 'index.html'), '<html>')
  const child = join(parent, 'app')
  await mkdir(child)
  const host = mockHost({
    results: { 'workspace.list': { workspaces: [WS('parent', parent), WS('child', child)], truncated: false } }
  })
  const worker = await mount(host)
  await worker.request('sites.get')
  const inChild = listenIn(3892, child)
  const inParent = listenIn(3893, parent)
  try {
    await waitOpen(3892)
    await waitOpen(3893)
    const res = (await worker.request('ports.get')) as { ports: { port: number; projectId: string | null }[] }
    // the deepest workspace owns the program: "child" is no project, so its port is not listed
    assert.equal(res.ports.find((p) => p.port === 3892), undefined)
    assert.equal(res.ports.find((p) => p.port === 3893)?.projectId, 'parent')
  } finally {
    inChild.kill()
    inParent.kill()
  }
})

t('settings accept only their own keys, never inherited ones', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mount(host)
  for (const key of ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor']) {
    await assert.rejects(worker.request('config.set', JSON.parse(`{"${key}": true}`)))
  }
})

t('a failed WordPress start leaves no temp folder behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-sites-'))
  await writeFile(join(dir, 'shop.php'), '<?php\n/*\n * Plugin Name: Shop\n * Requires Plugins: woocommerce\n */')
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [WS('w1', dir)], truncated: false },
      'terminal.create': () => {
        throw hostError('action_failed', 'no terminal')
      }
    }
  })
  const before = (await readdir(tmpdir())).filter((n) => n.startsWith('orca-local-sites-')).length
  const worker = await mount(host)
  await worker.request('sites.get')
  await assert.rejects(worker.request('site.start', { id: 'w1' }))
  const after = (await readdir(tmpdir())).filter((n) => n.startsWith('orca-local-sites-')).length
  assert.equal(after, before)
})

t('the project you are in comes first, whatever its name or favorites', async () => {
  // fixed folder names, the list is sorted by them
  const root = await mkdtemp(join(tmpdir(), 'local-sites-order-'))
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map((n) => join(root, n))
  for (const dir of [a, b, c]) {
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '16' }, scripts: { dev: 'next dev' } }))
  }
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'a', kind: 'folder', name: 'alpha', path: a, branch: 'refs/heads/main', hostId: null },
          { id: 'b', kind: 'folder', name: 'main', path: b, branch: 'refs/heads/main', hostId: null },
          { id: 'c', kind: 'folder', name: 'main', path: c, branch: 'refs/heads/main', hostId: null }
        ],
        truncated: false
      },
      'workspace.readContext': null,
      'terminal.list': (p: unknown) => ({
        terminals: (p as { workspaceId: string }).workspaceId === 'c' ? [{ id: 'tc' }] : [{ id: 'tb' }],
        truncated: false
      })
    }
  })
  const worker = await mount(host)
  const order = async () => ((await worker.request('sites.get')) as { sites: { id: string; current: boolean }[] }).sites.map((s) => `${s.id}${s.current ? '*' : ''}`)
  await worker.request('sites.get')
  await worker.request('site.pin', { id: 'a', pinned: true })
  assert.deepEqual(await order(), ['a', 'b', 'c'])
  const ctx = (extra: object) => ({ context: { branch: 'main', displayName: 'main', terminals: [], ...extra } })
  // the context names the workspace
  await worker.emit('workspace.changed', ctx({ workspaceId: 'c' }))
  assert.deepEqual(await order(), ['c*', 'a', 'b'])
  // without an id: two workspaces are called "main", the focused terminal decides
  await worker.emit('workspace.changed', ctx({ terminals: [{ id: 'tb' }] }))
  assert.deepEqual(await order(), ['b*', 'a', 'c'])
  // no match, or nothing focused: nobody is current
  await worker.emit('workspace.changed', ctx({ terminals: [{ id: 'unknown' }] }))
  assert.deepEqual(await order(), ['a', 'b', 'c'])
  await worker.emit('workspace.changed', ctx({ workspaceId: 'a' }))
  await worker.emit('workspace.changed', { context: null })
  assert.deepEqual(await order(), ['a', 'b', 'c'])
  // a unique name and branch is enough
  await worker.emit('workspace.changed', ctx({ displayName: 'alpha' }))
  assert.deepEqual(await order(), ['a*', 'b', 'c'])
})
