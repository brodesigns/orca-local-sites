import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Site, SitesState } from './protocol'

const site: Site = {
  id: 'w1', name: 'acme-shop', branch: 'main', runner: 'pnpm', framework: 'Next.js', status: 'stopped',
  port: null, url: null, error: null, warning: null, foreignUrl: null, hasErrors: false, problems: [], log: []
}
const running: Site = { ...site, status: 'running', port: 3201, url: 'http://localhost:3201', log: ['Ready'] }

test('start runs the worker, the browser button opens the site url', async () => {
  let current: SitesState = { sites: [site], updatedAt: 1 }
  const host = mockHost({
    requests: {
      'sites.get': () => current,
      'site.start': () => (current = { sites: [running], updatedAt: 2 })
    },
    results: { 'shell.openExternal': { opened: true } }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Open in browser' }), null)
  await view.press({ text: 'Start' })
  await view.press({ text: 'Open in browser' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: 'http://localhost:3201' }])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows an empty state without projects', async () => {
  const host = mockHost({ requests: { 'sites.get': { sites: [], updatedAt: 1 } } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'EmptyState' }))
  await view.unmount()
})
