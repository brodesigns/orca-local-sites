// Pure helpers: project detection, command building, log parsing
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackageManager } from './protocol'

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024

/**
 * Reads at most `max` bytes of a regular file. Symlinks, FIFOs and devices are refused, so a
 * hostile repo cannot make the worker hang or read without end. Returns null if refused.
 */
async function readCapped(file: string, max: number): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const st = await lstat(file)
    if (!st.isFile()) return null
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(max + 1)
      const { bytesRead } = await fh.read(buf, 0, max + 1, 0)
      return { text: buf.subarray(0, Math.min(bytesRead, max)).toString('utf8'), truncated: bytesRead > max }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/** How a framework takes its port: env var PORT or a CLI flag */
type PortMode = 'env' | '--port' | '-p'
type Framework = { id: string; label: string; deps: string[]; port: PortMode }

// First match wins, so meta-frameworks come before the tools they build on (vite)
const FRAMEWORKS: Framework[] = [
  { id: 'next', label: 'Next.js', deps: ['next'], port: 'env' },
  { id: 'nuxt', label: 'Nuxt', deps: ['nuxt', 'nuxt3'], port: '--port' },
  { id: 'astro', label: 'Astro', deps: ['astro'], port: '--port' },
  { id: 'sveltekit', label: 'SvelteKit', deps: ['@sveltejs/kit'], port: '--port' },
  { id: 'remix', label: 'Remix', deps: ['@remix-run/dev', '@react-router/dev'], port: '--port' },
  { id: 'gatsby', label: 'Gatsby', deps: ['gatsby'], port: '-p' },
  { id: 'angular', label: 'Angular', deps: ['@angular/cli'], port: '--port' },
  { id: 'cra', label: 'React', deps: ['react-scripts'], port: 'env' },
  { id: 'vite', label: 'Vite', deps: ['vite'], port: '--port' }
]
const SCRIPTS = ['dev', 'develop', 'start']

export type Kind = 'node' | 'static' | 'php' | 'wordpress'
export type ProjectInfo = {
  kind: Kind
  /** Package manager (node projects), else the tool that serves the site */
  manager: PackageManager | null
  framework: string
  label: string
  /** package.json script to run (node projects) */
  script: string | null
  port: PortMode | null
  /** PHP projects: serve "public" (Laravel style) or the project root */
  docroot: 'public' | '.'
  /** WordPress: plugins from wordpress.org the project needs (e.g. woocommerce) */
  plugins: string[]
  /** Node projects: there is no node_modules folder yet, so the start installs first */
  needsInstall: boolean
}

/** Pinned on purpose: the plugin runs this package via npx in your terminal */
export const PLAYGROUND_PACKAGE = '@wp-playground/cli@3.1.65'

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Detects the project type: WordPress plugin or theme, web framework, PHP or static site. Null if none. */
export async function detectProject(dir: string): Promise<ProjectInfo | null> {
  const wp = await detectWordPress(dir)
  if (wp) {
    return { kind: 'wordpress', manager: null, framework: 'wordpress', label: 'WordPress', script: null, port: null, docroot: '.', plugins: wp, needsInstall: false }
  }
  const node = await detectNode(dir)
  if (node) return node
  if (await exists(join(dir, 'public', 'index.php'))) return php('public')
  if (await exists(join(dir, 'index.php'))) return php('.')
  if (await exists(join(dir, 'index.html'))) {
    return { kind: 'static', manager: null, framework: 'static', label: 'Static site', script: null, port: null, docroot: '.', plugins: [], needsInstall: false }
  }
  return null
}

function php(docroot: 'public' | '.'): ProjectInfo {
  return { kind: 'php', manager: null, framework: 'php', label: 'PHP', script: null, port: null, docroot, plugins: [], needsInstall: false }
}

const HEADER_BYTES = 8192

const MAIN_FILE_BYTES = 64 * 1024
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_PLUGINS = 5

/** Slugs from the "Requires Plugins:" header (WordPress 6.5), plus WooCommerce if the code uses it */
function neededPlugins(header: string, code: string): string[] {
  const slugs = new Set<string>()
  const m = /^[ \t/*#@]*Requires Plugins:[ \t]*(.+)$/im.exec(header)
  for (const raw of m?.[1].split(',') ?? []) {
    const slug = raw.trim().toLowerCase()
    if (SLUG.test(slug)) slugs.add(slug)
  }
  if (/woocommerce/i.test(code)) slugs.add('woocommerce')
  return [...slugs].slice(0, MAX_PLUGINS)
}

/**
 * A WordPress plugin (PHP file with a "Plugin Name:" header) or theme (style.css with "Theme Name:").
 * Returns the wordpress.org plugins it needs, or null if the folder is no WordPress project.
 */
async function detectWordPress(dir: string): Promise<string[] | null> {
  const head = async (file: string, max = HEADER_BYTES): Promise<string> => (await readCapped(file, max))?.text ?? ''
  const themeHeader = await head(join(dir, 'style.css'))
  if (/^[ \t/*#@]*Theme Name:/im.test(themeHeader)) {
    return neededPlugins(themeHeader, (await head(join(dir, 'functions.php'), MAIN_FILE_BYTES)) + themeHeader)
  }
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.php')).slice(0, 50)
    for (const f of files) {
      const header = await head(join(dir, f))
      if (/^[ \t/*#@]*Plugin Name:/im.test(header)) return neededPlugins(header, await head(join(dir, f), MAIN_FILE_BYTES))
    }
  } catch {
    // unreadable folder
  }
  return null
}

async function detectNode(dir: string): Promise<ProjectInfo | null> {
  try {
    const raw = await readCapped(join(dir, 'package.json'), MAX_PACKAGE_JSON_BYTES)
    if (!raw || raw.truncated) return null
    const pkg: unknown = JSON.parse(raw.text)
    if (!pkg || typeof pkg !== 'object') return null
    const p = pkg as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; scripts?: Record<string, unknown> }
    const deps = { ...p.devDependencies, ...p.dependencies }
    const fw = FRAMEWORKS.find((f) => f.deps.some((d) => d in deps))
    if (!fw) return null
    const script = SCRIPTS.find((n) => typeof p.scripts?.[n] === 'string')
    if (!script) return null
    return { kind: 'node', manager: await detectManager(dir), framework: fw.id, label: fw.label, script, port: fw.port, docroot: '.', plugins: [], needsInstall: !(await installed(dir)) }
  } catch {
    return null
  }
}

/** Dependencies are there: node_modules, or Yarn Plug'n'Play which never has that folder */
async function installed(dir: string): Promise<boolean> {
  return (await exists(join(dir, 'node_modules'))) || (await exists(join(dir, '.pnp.cjs'))) || (await exists(join(dir, '.pnp.js')))
}

async function detectManager(dir: string): Promise<PackageManager> {
  if (await exists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if ((await exists(join(dir, 'bun.lock'))) || (await exists(join(dir, 'bun.lockb')))) return 'bun'
  if (await exists(join(dir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/** Script runner per package manager. Only fixed strings, the script name comes from SCRIPTS. */
function runScript(manager: PackageManager, script: string): string {
  if (manager === 'pnpm' || manager === 'yarn') return `${manager} ${script}`
  return `${manager} run ${script}`
}

// Absolute path of our own temp folder, no characters a shell would treat specially
const SAFE_PATH = /^\/[A-Za-z0-9_./-]{1,200}$/
// Project folder: absolute, goes inside single quotes, so no quote, backslash or control character
const SAFE_PROJECT_PATH = /^\/[^'\\\u0000-\u001f\u007f]{1,500}$/

export type WordPressRun = { workDir: string; project: string; blueprint?: string }

/** Blueprint (JSON) that installs the plugins a WordPress project needs, from wordpress.org */
export function blueprintFor(plugins: string[]): string {
  const steps = plugins
    .filter((slug) => SLUG.test(slug))
    .slice(0, MAX_PLUGINS)
    .map((slug) => ({ step: 'installPlugin', pluginData: { resource: 'wordpress.org/plugins', slug }, options: { activate: true } }))
  return JSON.stringify({ steps })
}

const INSTALL: Record<PackageManager, string> = { pnpm: 'pnpm install', npm: 'npm install', yarn: 'yarn install', bun: 'bun install' }

/** Shell command for the terminal. Only fixed strings and a checked integer go in. */
export function devCommand(info: ProjectInfo, port: number, wp?: WordPressRun): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port')
  switch (info.kind) {
    case 'static':
      return `python3 -I -m http.server ${port} --bind 127.0.0.1`
    case 'php':
      return `php -S 127.0.0.1:${port}${info.docroot === 'public' ? ' -t public' : ''}`
    case 'wordpress': {
      if (!wp) throw new Error('Missing WordPress run settings')
      if (!SAFE_PATH.test(wp.workDir) || (wp.blueprint !== undefined && !SAFE_PATH.test(wp.blueprint))) throw new Error('Invalid path')
      if (!SAFE_PROJECT_PATH.test(wp.project)) throw new Error('Invalid project path')
      const bp = wp.blueprint ? ` --blueprint ${wp.blueprint}` : ''
      // Runs from a private empty folder, so a hostile project cannot supply its own npx package or .npmrc
      return `cd '${wp.workDir}' && npx --yes --registry=https://registry.npmjs.org/ ${PLAYGROUND_PACKAGE} server --auto-mount='${wp.project}' --login --port ${port}${bp}`
    }
    case 'node': {
      if (!info.manager || !info.script || !info.port) throw new Error('Incomplete project')
      if (!SCRIPTS.includes(info.script)) throw new Error('Invalid script')
      const run = runScript(info.manager, info.script)
      // npm and bun need "--" to pass flags on to the script
      const sep = info.manager === 'npm' ? ' --' : ''
      const dev = info.port === 'env' ? `PORT=${port} ${run}` : `${run}${sep} ${info.port} ${port}`
      // A fresh worktree has no node_modules: install first, the dev server only starts if that worked
      return info.needsInstall ? `${INSTALL[info.manager]} && ${dev}` : dev
    }
  }
}

export const PORT_MIN = 3200
const PORT_SPAN = 700

/** Stable start port per project, so its URL stays the same between runs */
export function preferredPort(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return PORT_MIN + (h % PORT_SPAN)
}

const MAX_LINE_CHARS = 2000
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g

export function cleanLines(lines: string[], max: number): string[] {
  // Cut very long lines first, the regexes below are quadratic on huge inputs
  const out = lines.map((l) => l.slice(0, MAX_LINE_CHARS).replace(ANSI, '').replace(/\s+$/, ''))
  while (out.length && !out[out.length - 1]) out.pop()
  return out.slice(-max)
}

const FATAL_START = /command not found|ELIFECYCLE|ERR_PNPM|npm ERR!/i
/** First fatal line of a start that did not work, or null */
export function fatalStartLine(lines: string[]): string | null {
  return lines.find((l) => FATAL_START.test(l))?.trim().slice(0, 200) ?? null
}

// Shell prompt of the terminal ("user@host dir % command") and request lines of dev servers
const PROMPT = /^\S+@\S+ .*[%$#] ?/
const REQUEST_LINE = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+ \d{3} in \d+/
const SERVER_ERROR = /\b5\d\d in \d+/
const ERROR_LINE = /\b(error|failed|failure|fatal|exception|unhandled|EADDRINUSE|ELIFECYCLE|ENOENT|ERR_[A-Z_]+)\b|⨯|✖|Module not found|Cannot find module|Failed to compile/i
// A later success line means earlier errors are fixed
const SUCCESS = /✓ Compiled|compiled successfully|compiled in|\bready in\b|hmr update|page reload|Fast Refresh/i

/** Lines of `next` that are not yet in `prev` (both are snapshots of the terminal's tail) */
export function newLines(prev: string[], next: string[]): string[] {
  const overlap = (base: string[]): number => {
    for (let k = Math.min(base.length, next.length); k > 0; k--) {
      let same = true
      for (let i = 0; i < k && same; i++) same = base[base.length - k + i] === next[i]
      if (same) return k
    }
    return 0
  }
  const k = overlap(prev)
  if (k) return next.slice(k)
  // A progress bar redraws the last line: match everything before it, take the redrawn line as new
  const k2 = prev.length > 1 ? overlap(prev.slice(0, -1)) : 0
  return k2 ? next.slice(k2) : next
}

/**
 * Errors of the output history, each with up to two following lines (file, stack). Prompts,
 * request lines and everything before the last success line are left out, identical groups once.
 */
export function problemsFrom(history: string[], maxLines = 30): string[] {
  let from = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (SUCCESS.test(history[i])) {
      from = i + 1
      break
    }
  }
  const lines = history.slice(from)
  const seen = new Set<string>()
  const out: string[] = []
  const quiet = (l: string) => l.trim() && !PROMPT.test(l) && !REQUEST_LINE.test(l)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim() || PROMPT.test(l)) continue
    const isRequest = REQUEST_LINE.test(l)
    if (isRequest ? !SERVER_ERROR.test(l) : !ERROR_LINE.test(l)) continue
    const group = [l, ...lines.slice(i + 1, i + 3).filter(quiet)].map((x) => x.trim().slice(0, 200))
    const key = group.join('\n')
    // The context lines belong to this group, they do not start their own
    i += Math.min(2, lines.length - 1 - i)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(...group)
  }
  return out.slice(-maxLines)
}

const ANNOUNCE = /\b(local|ready|listening|running|started|serving|server)\b/i

/** Port a server announces ("Local: http://localhost:3000"), if it is none of the `exclude` ports */
export function portFromLog(lines: string[], exclude: ReadonlySet<number> = new Set()): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!ANNOUNCE.test(lines[i])) continue
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]):(\d{4,5})\b/.exec(lines[i])
    if (m) {
      const port = Number(m[1])
      if (port >= 1024 && port <= 65535 && !exclude.has(port)) return port
    }
  }
  return null
}

const PORT_CONFLICT = /EADDRINUSE|Address already in use|Failed to listen|Another .{0,20}dev server is already running/i

/** A line saying the port was taken: the server did not start even if something answers there */
export function portConflictLine(lines: string[]): string | null {
  return lines.find((l) => PORT_CONFLICT.test(l))?.trim().slice(0, 200) ?? null
}

/** Readable label: "project / worktree" for Orca worktrees, else the folder name */
export function siteLabel(path: string, name: string): string {
  const parts = path.split('/').filter(Boolean)
  const parent = parts.at(-2)
  if (parts.at(-3) === 'workspaces' && parent) return `${parent} / ${name}`
  return parts.at(-1) ?? name
}
