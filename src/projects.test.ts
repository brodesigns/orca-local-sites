import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { blueprintFor, cleanLines, detectProject, type ProjectInfo, devCommand, fatalStartLine, newLines, portConflictLine, portFromLog, problemsFrom, preferredPort, siteLabel } from './projects'

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-sites-'))
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return dir
}

async function detect(deps: Record<string, string>, scripts: Record<string, string>, extra: Record<string, string> = {}) {
  return detectProject(await project({ 'package.json': JSON.stringify({ dependencies: deps, scripts }), ...extra }))
}

const base: ProjectInfo = { kind: 'node', manager: 'pnpm', framework: 'next', label: 'Next.js', script: 'dev', port: 'env', docroot: '.', plugins: [], needsInstall: false }

test('detects the framework, script and package manager', async () => {
  // a fresh worktree has no node_modules
  assert.deepEqual(await detect({ next: '16' }, { dev: 'next dev' }, { 'pnpm-lock.yaml': '' }), { ...base, needsInstall: true })
  assert.equal((await detect({ astro: '5' }, { dev: 'astro dev' }, { 'yarn.lock': '' }))?.label, 'Astro')
  assert.equal((await detect({ nuxt: '3' }, { dev: 'nuxt dev' }))?.label, 'Nuxt')
  assert.equal((await detect({ '@sveltejs/kit': '2', vite: '5' }, { dev: 'vite dev' }))?.label, 'SvelteKit')
  assert.equal((await detect({ vite: '6' }, { dev: 'vite' }))?.label, 'Vite')
  assert.equal((await detect({ gatsby: '5' }, { develop: 'gatsby develop' }))?.script, 'develop')
  assert.equal((await detect({ 'react-scripts': '5' }, { start: 'react-scripts start' }))?.script, 'start')
  assert.equal((await detect({ vite: '6' }, { dev: 'vite' }, { 'bun.lock': '' }))?.manager, 'bun')
  assert.equal((await detect({ vite: '6' }, { dev: 'vite' }))?.manager, 'npm')
})

test('ignores folders that are no web project', async () => {
  assert.equal(await detect({ express: '4' }, { dev: 'node server.js' }), null)
  assert.equal(await detect({ next: '16' }, { build: 'next build' }), null)
  assert.equal(await detectProject(await project({ 'package.json': '{broken' })), null)
  assert.equal(await detectProject(await project({})), null)
  assert.equal(await detectProject(await project({ 'helper.php': '<?php echo 1;' })), null)
})

test('detects WordPress plugins and themes before anything else', async () => {
  const plugin = await detectProject(await project({ 'my-plugin.php': '<?php\n/**\n * Plugin Name: My Plugin\n */' }))
  assert.equal(plugin?.kind, 'wordpress')
  const theme = await detectProject(await project({ 'style.css': '/*\nTheme Name: My Theme\n*/' }))
  assert.equal(theme?.kind, 'wordpress')
  // a WordPress plugin with a vite build is still a WordPress project
  const withVite = await detectProject(
    await project({
      'my-plugin.php': '<?php\n/* Plugin Name: X */',
      'package.json': JSON.stringify({ devDependencies: { vite: '6' }, scripts: { dev: 'vite' } })
    })
  )
  assert.equal(withVite?.kind, 'wordpress')
})

test('install first when node_modules is missing', async () => {
  const dir = await project({ 'package.json': JSON.stringify({ dependencies: { next: '16' }, scripts: { dev: 'next dev' } }), 'pnpm-lock.yaml': '' })
  assert.equal((await detectProject(dir))?.needsInstall, true)
  await mkdir(join(dir, 'node_modules'))
  assert.equal((await detectProject(dir))?.needsInstall, false)
  assert.equal(devCommand({ ...base, needsInstall: true }, 3201), 'pnpm install && PORT=3201 pnpm dev')
  assert.equal(devCommand({ ...base, needsInstall: true, manager: 'npm', port: '--port' }, 3201), 'npm install && npm run dev -- --port 3201')
  assert.equal(devCommand({ ...base, needsInstall: true, manager: 'yarn' }, 3201), 'yarn install && PORT=3201 yarn dev')
})

test('Yarn Plug\'n\'Play counts as installed', async () => {
  const pkg = JSON.stringify({ dependencies: { next: '16' }, scripts: { dev: 'next dev' } })
  assert.equal((await detectProject(await project({ 'package.json': pkg, 'yarn.lock': '', '.pnp.cjs': '' })))?.needsInstall, false)
})

test('detects PHP and static sites', async () => {
  assert.equal((await detectProject(await project({ 'index.php': '<?php' })))?.kind, 'php')
  assert.equal((await detectProject(await project({ 'index.html': '<html>' })))?.kind, 'static')
  const dir = await project({})
  await mkdir(join(dir, 'public'))
  await writeFile(join(dir, 'public', 'index.php'), '<?php')
  assert.equal((await detectProject(dir))?.docroot, 'public')
})

test('dev command fits the project type', () => {
  assert.equal(devCommand(base, 3201), 'PORT=3201 pnpm dev')
  assert.equal(devCommand({ ...base, manager: 'npm' }, 3201), 'PORT=3201 npm run dev')
  assert.equal(devCommand({ ...base, port: '--port' }, 3201), 'pnpm dev --port 3201')
  assert.equal(devCommand({ ...base, manager: 'npm', port: '--port' }, 3201), 'npm run dev -- --port 3201')
  assert.equal(devCommand({ ...base, manager: 'yarn', script: 'develop', port: '-p' }, 3201), 'yarn develop -p 3201')
  assert.equal(devCommand({ ...base, kind: 'static', manager: null, script: null, port: null }, 3201), 'python3 -I -m http.server 3201 --bind 127.0.0.1')
  assert.equal(devCommand({ ...base, kind: 'php', manager: null, script: null, port: null }, 3201), 'php -S 127.0.0.1:3201')
  assert.equal(devCommand({ ...base, kind: 'php', manager: null, script: null, port: null, docroot: 'public' }, 3201), 'php -S 127.0.0.1:3201 -t public')
})

test('dev command only accepts a valid port and a known script', () => {
  assert.throws(() => devCommand(base, 80))
  assert.throws(() => devCommand(base, 3000.5))
  assert.throws(() => devCommand(base, Number('3000; rm -rf /')))
  assert.throws(() => devCommand({ ...base, script: 'dev; rm -rf /' }, 3201))
  assert.throws(() => devCommand({ ...base, kind: 'php', manager: null, script: null, port: null }, 70000))
})

test('symlinks and special files are never read', async () => {
  // A symlink to /dev/zero looks empty to stat and would be read without end
  const dir = await project({})
  await symlink('/dev/zero', join(dir, 'package.json'))
  await symlink('/dev/zero', join(dir, 'style.css'))
  await symlink('/dev/zero', join(dir, 'evil.php'))
  assert.equal(await detectProject(dir), null)
})

test('oversized package.json and headers are cut off', async () => {
  const big = JSON.stringify({ dependencies: { next: '16' }, scripts: { dev: 'next dev' }, pad: 'x'.repeat(2 * 1024 * 1024) })
  assert.equal(await detectProject(await project({ 'package.json': big })), null)
  // The header must sit in the first 8 KB
  assert.equal((await detectProject(await project({ 'p.php': ' '.repeat(9000) + '\n/* Plugin Name: Late */' })))?.kind ?? null, null)
})

test('preferred port is stable and in range', () => {
  assert.equal(preferredPort('ws-1'), preferredPort('ws-1'))
  for (const k of ['a', 'ws-1', 'x'.repeat(200)]) {
    const p = preferredPort(k)
    assert.ok(p >= 3200 && p < 3900)
  }
})

test('cleanLines strips colors and trailing blanks', () => {
  assert.deepEqual(cleanLines(['\u001b[32m✓\u001b[0m Ready  ', '', ''], 10), ['✓ Ready'])
  assert.deepEqual(cleanLines(['a', 'b', 'c'], 2), ['b', 'c'])
})

test('log port: only announced ports, never ports of other sessions', () => {
  assert.equal(portFromLog(['API proxy: http://localhost:8080']), null)
  assert.equal(portFromLog(['  - Local: http://localhost:3055', 'API: http://localhost:8080']), 3055)
  assert.equal(portFromLog(['  - Local: http://localhost:3055'], new Set([3055])), null)
  assert.ok(portConflictLine(['Error: listen EADDRINUSE: address already in use :::3201']))
  assert.equal(portConflictLine(['ENOENT: warning only']), null)
})

test('log parsing: port, fatal start errors, error lines', () => {
  assert.equal(portFromLog(['  - Local:   http://localhost:3055']), 3055)
  assert.equal(portFromLog(['nothing here']), null)
  assert.equal(fatalStartLine(['Error: listen EADDRINUSE: address already in use :::3000']), null)
  assert.ok(portConflictLine(['OSError: [Errno 48] Address already in use']))
  assert.ok(portConflictLine(['⨯ Another next dev server is already running.']))
  assert.ok(fatalStartLine(['sh: vite: command not found']))
  // A harmless warning must not end the start
  assert.equal(fatalStartLine(['Warning: ENOENT .env.local', 'Cannot find module optional']), null)
  assert.equal(fatalStartLine(['✓ Ready in 1s']), null)
})

test('site label shows project and worktree', () => {
  assert.equal(siteLabel('/Users/x/orca/workspaces/shop/animation', 'animation'), 'shop / animation')
  assert.equal(siteLabel('/Users/x/Documents/Tools/shop', 'main'), 'shop')
})

test('newLines returns only what scrolled in since the last snapshot', () => {
  assert.deepEqual(newLines([], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(newLines(['a', 'b', 'c'], ['b', 'c', 'd', 'e']), ['d', 'e'])
  assert.deepEqual(newLines(['a', 'b'], ['a', 'b']), [])
  assert.deepEqual(newLines(['a', 'b'], ['x', 'y']), ['x', 'y'])
})

test('problems: errors with context, no prompts or request noise, cleared by a later success', () => {
  const noise = [
    'user@mac shop % pnpm dev',
    ' GET /api/status 200 in 25ms (next.js: 8ms)',
    ' POST /api/event 200 in 98ms',
    '- srcSet={"/_next/image"}',
    '+ src={"/_next/image"}'
  ]
  assert.deepEqual(problemsFrom(noise), [])
  const broken = [...noise, ' ⨯ Failed to compile', './app/page.tsx', "Module not found: Can't resolve './hero'", 'next line', 'unrelated']
  assert.deepEqual(problemsFrom(broken), ['⨯ Failed to compile', './app/page.tsx', "Module not found: Can't resolve './hero'"])
  assert.ok(problemsFrom([...broken, ' GET /api/x 500 in 12ms']).some((l) => l.includes('500')))
  // fixed by a later successful compile
  assert.deepEqual(problemsFrom([...broken, ' ✓ Compiled /page in 300ms']), [])
  // the same error twice is shown once
  assert.deepEqual(problemsFrom([...broken, 'x', ...broken.slice(-4)]).filter((l) => l.includes('Failed')).length, 1)
})

test('WordPress: plugins the project needs go into a blueprint', async () => {
  const header = '<?php\n/*\n * Plugin Name: Shop\n * Requires Plugins: woocommerce, Advanced-Custom-Fields, bad slug!\n */'
  assert.deepEqual((await detectProject(await project({ 'shop.php': header })))?.plugins, ['woocommerce', 'advanced-custom-fields'])
  // WooCommerce used in the code, far below the header
  const code = '<?php\n/* Plugin Name: Shop */\n' + '// x\n'.repeat(3000) + "add_filter('woocommerce_locate_template', 'x');"
  assert.deepEqual((await detectProject(await project({ 'shop.php': code })))?.plugins, ['woocommerce'])
  assert.deepEqual((await detectProject(await project({ 'plain.php': '<?php\n/* Plugin Name: Plain */' })))?.plugins, [])
  const wp: ProjectInfo = { ...base, kind: 'wordpress', manager: null, script: null, port: null, plugins: ['woocommerce'] }
  const run = { workDir: '/var/tmp/orca-local-sites-aB1', project: '/Users/me/My Plugins/shop', blueprint: '/var/tmp/orca-local-sites-aB1/blueprint.json' }
  assert.equal(
    devCommand(wp, 3201, run),
    "cd '/var/tmp/orca-local-sites-aB1' && npx --yes --registry=https://registry.npmjs.org/ " +
      "@wp-playground/cli@3.1.65 server --auto-mount='/Users/me/My Plugins/shop' --login --port 3201 --blueprint /var/tmp/orca-local-sites-aB1/blueprint.json"
  )
  assert.throws(() => devCommand(wp, 3201))
  assert.throws(() => devCommand(wp, 3201, { ...run, blueprint: '/tmp/x; rm -rf /' }))
  assert.throws(() => devCommand(wp, 3201, { ...run, workDir: 'relative' }))
  assert.throws(() => devCommand(wp, 3201, { ...run, project: "/Users/me/it's" }))
  assert.throws(() => devCommand(wp, 3201, { ...run, project: '/Users/me/a\nb' }))
  assert.deepEqual(JSON.parse(blueprintFor(['woocommerce', 'evil slug'])).steps.length, 1)
})

test('newLines survives a redrawn last line, cleanLines cuts huge lines', () => {
  // progress bar: the last line changes in place
  assert.deepEqual(newLines(['a', 'b', 'progress 10%'], ['a', 'b', 'progress 20%']), ['progress 20%'])
  const start = Date.now()
  const long = ['x@'.repeat(100_000), ' '.repeat(100_000)]
  assert.equal(cleanLines(long, 10).every((l) => l.length <= 2000), true)
  assert.ok(Date.now() - start < 500)
})
