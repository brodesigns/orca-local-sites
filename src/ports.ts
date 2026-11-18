// Lists the TCP ports that listen on this machine, with process name and working folder
import { execFile } from 'node:child_process'

export type Listener = { port: number; pid: number; process: string; cwd: string | null }

const LSOF_TIMEOUT_MS = 5000
const LSOF_MAX_BYTES = 2 * 1024 * 1024

function lsof(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('lsof', args, { timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_BYTES }, (err, stdout) => {
      // lsof exits with 1 when it found nothing, that is no error here
      if (err && !stdout) reject(err)
      else resolve(stdout)
    })
  })
}

/** Parses `lsof -F pcn` output of listening sockets: one entry per port and process */
export function parseListeners(out: string): Listener[] {
  const found = new Map<string, Listener>()
  let pid = 0
  let name = ''
  for (const line of out.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') pid = /^\d+$/.test(value) ? Number(value) : 0
    else if (tag === 'c') name = value.slice(0, 60)
    else if (tag === 'n' && pid) {
      const port = Number(value.slice(value.lastIndexOf(':') + 1))
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        found.set(`${pid}:${port}`, { port, pid, process: name, cwd: null })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port || a.pid - b.pid)
}

/** Parses `lsof -d cwd -F pn` output into a pid -> folder map */
export function parseCwds(out: string): Map<number, string> {
  const map = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = /^\d+$/.test(line.slice(1)) ? Number(line.slice(1)) : 0
    else if (line[0] === 'n' && pid && line[1] === '/') map.set(pid, line.slice(1))
  }
  return map
}

/** All listening TCP ports, or null if lsof is not available */
export async function listListeners(): Promise<Listener[] | null> {
  try {
    const listeners = parseListeners(await lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']))
    // Only numeric pids go into the second call, never text from the first output
    const pids = [...new Set(listeners.map((l) => l.pid))].filter((p) => Number.isSafeInteger(p) && p > 0)
    if (pids.length) {
      const cwds = parseCwds(await lsof(['-nP', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']).catch(() => ''))
      for (const l of listeners) l.cwd = cwds.get(l.pid) ?? null
    }
    return listeners
  } catch {
    return null
  }
}

// Programs that serve websites in dev: tools like agents, MCP servers or browsers also listen on ports, but are no site
const WEB_RUNTIME = /^(node|bun|deno|python[\d.]*|php|php-fpm|ruby|next-server|vite|npm|pnpm|yarn|caddy|hugo|jekyll)$/i

export function isWebRuntime(processName: string): boolean {
  return WEB_RUNTIME.test(processName)
}
