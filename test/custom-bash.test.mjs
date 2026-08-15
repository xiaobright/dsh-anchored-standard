import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name, pickWindowsBash, resolveDefaultBash } from '../preset/custom-bash.mjs'

function register(config) {
  const registered = []
  const spawnCalls = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) {
        return path
      },
      spawn(options) {
        spawnCalls.push(options)
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom() { return { text: 'hello from bash' } } },
            stderr: { readFrom() { return { text: '' } } },
          },
        }
      },
    },
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
  }
  apply(ctx, config)
  return { tool: registered[0], spawnCalls, ctx }
}

const exec = (overrides = {}) => ({
  agent: { session: { id: 's', header: { cwd: 'C:/work' } } },
  signal: undefined,
  ...overrides,
})

test('exports a diagnostic plugin name and injects subprocess + tools', () => {
  assert.equal(name, 'custom-bash')
  assert.deepEqual(inject.sort(), ['subprocess', 'tools'].sort())
})

test('registers the bash tool with a Minimal-compatible description', () => {
  const { tool } = register()
  assert.equal(tool.name, 'bash')
  assert.match(tool.description, /Run commands in a bash shell/)
  assert.ok(tool.parameters.required.includes('command'))
  assert.ok(tool.output.schema)
})

test('execute spawns `bash -c <command>` and returns the combined output', async () => {
  const { tool, spawnCalls } = register({ bashPath: 'C:/Program Files/Git/bin/bash.exe' })
  const result = await tool.execute({ command: 'echo hi' }, exec())
  assert.equal(result.text, 'hello from bash')
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].argv, ['C:/Program Files/Git/bin/bash.exe', '-c', 'echo hi'])
})

test('execute passes the session cwd by default and honors an explicit workdir', async () => {
  const { tool, spawnCalls } = register()
  await tool.execute({ command: 'pwd' }, exec())
  assert.equal(spawnCalls[0].cwd, 'C:/work')
  await tool.execute({ command: 'pwd', workdir: 'D:/other' }, exec())
  assert.equal(spawnCalls[1].cwd, 'D:/other')
})

test('a non-zero exit throws with the captured output', async () => {
  const registered = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 2 }),
          collected: {
            stdout: { readFrom() { return { text: 'boom' } } },
            stderr: { readFrom() { return { text: '' } } },
          },
        }
      },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx)
  await assert.rejects(() => registered[0].execute({ command: 'false' }, exec()), /boom/)
})

test('a spawn-level failure throws a descriptive error', async () => {
  const registered = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn() {
        return { done: Promise.reject(new Error('EPERM: operation not permitted')) }
      },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx)
  await assert.rejects(() => registered[0].execute({ command: 'x' }, exec()), /bash spawn failed/)
})

test('missing output readers degrade to the exit code text', async () => {
  const registered = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom() { throw new Error('unavailable') } },
            stderr: { readFrom() { throw new Error('unavailable') } },
          },
        }
      },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx)
  const result = await registered[0].execute({ command: 'x' }, exec())
  assert.match(result.text, /exit code: 0/)
})

test('without config the executable is detected on Windows or falls back to `bash`', async () => {
  const resolved = []
  const registered = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { resolved.push(path); return path },
      spawn() { return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom() { return { text: 'ok' } } }, stderr: { readFrom() { return { text: '' } } } } } },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx)
  await registered[0].execute({ command: 'x' }, exec())
  assert.equal(resolved.length, 1)
  const chosen = resolved[0]
  if (chosen !== 'bash') {
    assert.match(chosen.toLowerCase(), /bash\.exe$/, 'the auto-detected Windows executable is a bash.exe path (issue #28)')
  }
})

test('pickWindowsBash prefers a Git-installed bash over other non-system bash and the WSL shim', () => {
  const existing = new Set([
    'C:\\Users\\me\\scoop\\shims\\bash.exe',
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ])
  const exists = (p) => existing.has(p)
  const pathEnv = 'C:\\Windows\\System32;C:\\Users\\me\\scoop\\shims;C:\\Program Files\\Git\\bin'
  assert.equal(
    pickWindowsBash(pathEnv, 'C:\\Windows', exists),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  )
})

test('pickWindowsBash prefers any non-system bash over the WSL shim (scoop installs)', () => {
  const exists = (p) => p === 'C:\\Users\\me\\scoop\\shims\\bash.exe' || p === 'C:\\Windows\\System32\\bash.exe'
  const pathEnv = 'C:\\Windows\\System32;C:\\Users\\me\\scoop\\shims'
  assert.equal(pickWindowsBash(pathEnv, 'C:\\Windows', exists), 'C:\\Users\\me\\scoop\\shims\\bash.exe')
})

test('pickWindowsBash falls back to the WSL shim when it is the only bash', () => {
  const exists = (p) => p === 'C:\\Windows\\System32\\bash.exe'
  assert.equal(pickWindowsBash('C:\\Windows\\System32;C:\\elsewhere', 'C:\\Windows', exists), 'C:\\Windows\\System32\\bash.exe')
})

test('pickWindowsBash tolerates quoted entries and returns undefined when nothing exists', () => {
  const exists = (p) => p === 'D:\\tools\\bash.exe'
  assert.equal(pickWindowsBash('"D:\\tools";', 'C:\\Windows', exists), 'D:\\tools\\bash.exe')
  assert.equal(pickWindowsBash('C:\\a;C:\\b', 'C:\\Windows', () => false), undefined)
})

test('resolveDefaultBash honors the explicit config, detects on win32, and falls back to bash', () => {
  assert.equal(resolveDefaultBash('C:\\custom\\bash.exe', 'win32', '', 'C:\\Windows', () => false), 'C:\\custom\\bash.exe')
  assert.equal(resolveDefaultBash(undefined, 'win32', 'C:\\x', 'C:\\Windows', () => true), 'C:\\x\\bash.exe')
  assert.equal(resolveDefaultBash(undefined, 'win32', 'C:\\x', 'C:\\Windows', () => false), 'bash')
  assert.equal(resolveDefaultBash(undefined, 'linux', 'C:\\x', 'C:\\Windows', () => true), 'bash')
})
