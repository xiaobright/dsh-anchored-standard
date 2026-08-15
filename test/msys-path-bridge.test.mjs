import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../preset/msys-path-bridge.mjs'

const kScope = Symbol('dsh.scope')
const scopeKey = { standing: 'test' }

function editorDefinition() {
  return {
    name: 'str_replace_editor',
    description: 'editor',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } } },
      render() {
        return { text: '' }
      },
    },
    async execute(args, exec) {
      return { exec, args }
    },
  }
}

test('shadow wrap reuses compiled schemas verbatim and converts MSYS paths', { skip: process.platform !== 'win32' }, async () => {
  const original = editorDefinition()
  const registrations = []
  let current = original
  const ctx = {
    [kScope]: scopeKey,
    tools: {
      get(name, scope) {
        assert.equal(scope, scopeKey)
        return name === current.name ? current : undefined
      },
      register(tool) {
        registrations.push(tool)
        current = tool
      },
    },
    on() {},
  }

  apply(ctx, { tools: ['str_replace_editor'] })
  await new Promise(resolve => queueMicrotask(resolve))

  assert.equal(registrations.length, 1)
  const wrapper = registrations[0]
  assert.equal(wrapper.parameters, original.parameters)
  assert.equal(wrapper.output, original.output)
  const result = await wrapper.execute({ path: '/c/Users/10531/x.txt' }, 'EXEC')
  assert.deepEqual(result.args, { path: 'C:\\Users\\10531\\x.txt' })
  assert.equal(result.exec, 'EXEC')
})

test('same-scope duplicate falls back to in-place execute wrapping', { skip: process.platform !== 'win32' }, async () => {
  const original = editorDefinition()
  const firstExecute = original.execute
  const ctx = {
    [kScope]: scopeKey,
    tools: {
      get(name, scope) {
        assert.equal(scope, scopeKey)
        return name === original.name ? original : undefined
      },
      register() {
        throw new Error('tool "str_replace_editor" is already registered in this scope')
      },
    },
    on() {},
  }

  apply(ctx, { tools: ['str_replace_editor'] })
  await new Promise(resolve => queueMicrotask(resolve))

  assert.notEqual(original.execute, firstExecute)
  const result = await original.execute({ path: '/d/work/a.txt' }, 'EXEC')
  assert.deepEqual(result.args, { path: 'D:\\work\\a.txt' })
  assert.equal(result.exec, 'EXEC')
})
