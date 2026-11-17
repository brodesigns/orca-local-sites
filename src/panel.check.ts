// Scenarios for `orca plugin check` and `orca plugin shot --scenario`, with demo data only
import { defineCheck } from 'orca/testing'
import type { SitesState } from './protocol'

const base = { error: null, warning: null, foreignUrl: null, hasErrors: false, problems: [] as string[], log: [] as string[], port: null, url: null }

const state: SitesState = {
  updatedAt: Date.now(),
  sites: [
    {
      ...base,
      id: 'w1',
      name: 'acme-shop',
      branch: 'main',
      runner: 'pnpm',
      framework: 'Next.js',
      status: 'running',
      port: 3201,
      url: 'http://localhost:3201',
      hasErrors: true,
      problems: ['⨯ Failed to compile', './app/page.tsx', "Module not found: Can't resolve './hero'"],
      log: ['  ▲ Next.js 16.0.0', '  - Local: http://localhost:3201', ' ✓ Ready in 1.2s', ' ⨯ Failed to compile', './app/page.tsx: Module not found']
    },
    { ...base, id: 'w2', name: 'acme-landing', branch: 'main', runner: 'npm', framework: 'Astro', status: 'stopped' },
    {
      ...base,
      id: 'w3',
      name: 'acme-docs',
      branch: 'feature/search',
      runner: 'pnpm',
      framework: 'Vite',
      status: 'error',
      error: 'Error: listen EADDRINUSE: address already in use :::3300',
      problems: ['Error: listen EADDRINUSE: address already in use :::3300'],
      log: ['Error: listen EADDRINUSE: address already in use :::3300']
    }
  ]
}

export default defineCheck({
  list: { requests: { 'sites.get': state } },
  empty: { requests: { 'sites.get': { sites: [], updatedAt: Date.now() } } }
})
