import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../preset/gitbash-tool.mjs'

function register(config = {}) {
  const registered = []
  const resolved = []
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    shell: {
      resolve(request) {
        resolved.push(request)
        return request
      },
      async run(spec) {
        return {
          exitCode: 0,
          signal: null,
          aborted: false,
          timedOut: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: `ok:${spec.command}` },
          stderr: { text: '' },
        }
      },
    },
  }
  apply(ctx, config)
  return { tool: registered[0], resolved }
}

test('exports the diagnostic plugin name and injects shell plus tools', () => {
  assert.equal(name, 'gitbash-tool')
  assert.deepEqual(inject, ['shell', 'tools'])
})

test('registers a Minimal-compatible bash surface', () => {
  const { tool } = register()
  assert.equal(tool.name, 'bash')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['command', 'workdir'])
  assert.deepEqual(tool.parameters.required, ['command'])
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.required[0], 'text')
})

test('executes through the shell executor and reports text', async () => {
  const { tool, resolved } = register({ timeoutMs: 3000, maxOutputBytes: 123 })
  const result = await tool.execute({ command: 'echo hi', workdir: '/c/Users/10531' }, {})
  assert.deepEqual(result, { text: 'ok:echo hi' })
  assert.equal(resolved[0].workdir, '/c/Users/10531')
  assert.equal(resolved[0].timeoutMs, 3000)
  assert.equal(resolved[0].stdoutMaxBytes, 123)
})

test('rejects an empty command', async () => {
  const { tool } = register()
  await assert.rejects(() => tool.execute({ command: '   ' }, {}), /command must be a non-empty string/)
})

test('reports non-zero exits as errors', async () => {
  const registered = []
  const ctx = {
    tools: { register(tool) { registered.push(tool) } },
    shell: {
      resolve(request) { return request },
      async run() {
        return {
          exitCode: 7,
          aborted: false,
          timedOut: false,
          timeoutMs: 1000,
          stdout: { text: 'boom' },
          stderr: { text: '' },
        }
      },
    },
  }
  apply(ctx, {})
  await assert.rejects(() => registered[0].execute({ command: 'false' }, {}), /boom/)
})

test('forwards the calling session sandbox policy to the executor', async () => {
  const registered = []
  const resolved = []
  const session = { id: 's1', header: { cwd: 'C:/proj' } }
  const policy = { mode: 'danger-full-access', workspaceRoot: 'C:/proj', sessionId: 's1' }
  const ctx = {
    get(service) {
      assert.equal(service, 'sandboxPolicy')
      return {
        resolve(request) {
          assert.equal(request.session, session)
          return policy
        },
      }
    },
    tools: { register(tool) { registered.push(tool) } },
    shell: {
      sandboxMode: 'workspace-write',
      resolve(request) {
        resolved.push(request)
        return request
      },
      async run(spec) {
        return {
          exitCode: 0,
          aborted: false,
          timedOut: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: `ok:${spec.command}` },
          stderr: { text: '' },
        }
      },
    },
  }
  apply(ctx)
  await registered[0].execute({ command: 'pwd' }, { agent: { session } })
  assert.deepEqual(resolved[0].sandboxPolicy, policy)
})

test('a confining executor without sandboxPolicy fails at apply time', () => {
  const ctx = {
    get() { return undefined },
    tools: { register() {} },
    shell: { sandboxMode: 'workspace-write', resolve() {}, run() {} },
  }
  assert.throws(() => apply(ctx, {}), /sandboxPolicy is missing/)
})


test('invalid config fails at apply time', () => {
  const ctx = {
    tools: { register() {} },
    shell: { resolve() {}, run() {} },
  }
  assert.throws(() => apply(ctx, { timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => apply(ctx, { maxOutputBytes: -1 }), /maxOutputBytes/)
})
