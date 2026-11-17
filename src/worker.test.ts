import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

// Every test stops its workers, even when an assertion fails (a live worker timer keeps node running)
const workers: { deactivate(): Promise<void> }[] = []
async function mount(host: ReturnType<typeof mockHost>) {
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

async function nextProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-sites-'))
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
