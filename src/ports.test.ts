import { assert, test } from 'orca/testing'
import { isWebRuntime, parseCwds, parseListeners } from './ports'

test('parses lsof listener output, one entry per port and process', () => {
  const out = ['p1347', 'cpostgres', 'n127.0.0.1:5432', 'n[::1]:5432', 'p53095', 'cnode', 'n*:3000', 'n*:3000', 'p9', 'cbad', 'nnot-a-port'].join('\n')
  assert.deepEqual(parseListeners(out), [
    { port: 3000, pid: 53095, process: 'node', cwd: null },
    { port: 5432, pid: 1347, process: 'postgres', cwd: null }
  ])
})

test('ignores broken lines and non-numeric pids', () => {
  assert.deepEqual(parseListeners('pabc\ncx\nn*:80\n\nn*:3000'), [])
  assert.deepEqual(parseListeners(''), [])
  assert.deepEqual(parseListeners(['p5', 'c' + 'x'.repeat(500), 'n*:99999'].join('\n')), [])
})

test('parses working folders per pid, only absolute paths', () => {
  const out = ['p10', 'fcwd', 'n/Users/me/shop', 'p11', 'fcwd', 'nrelative', 'p12', 'fcwd', 'n/'].join('\n')
  assert.deepEqual([...parseCwds(out)], [[10, '/Users/me/shop'], [12, '/']])
})

test('only web runtimes count as sites, not agents, browsers or databases', () => {
  for (const name of ['node', 'Python', 'php', 'bun', 'next-server']) assert.equal(isWebRuntime(name), true)
  for (const name of ['agy', 'codebase-memory-mcp', 'Google Chrome', 'postgres', 'nodemon-evil', '']) assert.equal(isWebRuntime(name), false)
})
