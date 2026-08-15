import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../whoami-standard/zero-tool-bootstrap.mjs'

function register() {
  const listeners = {}
  const ctx = {
    on(event, callback) {
      listeners[event] = callback
    },
    logger: { warn() {} },
  }
  apply(ctx, {})
  return listeners
}

test('whoami zero-tool bootstrap exports a diagnostic plugin name', () => {
  assert.equal(name, 'zero-tool-bootstrap')
})

test('whoami zero-tool bootstrap ignores inherited fork events below seedLength', async () => {
  const listeners = register()
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' },
    { name: 'dev_tool_search' }, { name: 'web_search' }, { name: 'subagent' },
  ]
  const session = {
    id: 'fork',
    header: { seedLength: 2 },
    events: [
      { seq: 0, type: 'assistant/message', data: {} },
      { seq: 1, type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search"]}' } },
    ],
  }
  const cold = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(cold.tools, [])

  const ownPromotion = { seq: 2, type: 'assistant/message', data: {} }
  const ownUnlock = { seq: 3, type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["subagent"]}' } }
  session.events.push(ownPromotion, ownUnlock)
  listeners['session/event'](session, ownPromotion)
  const promoted = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session } },
    async () => ({ system: 'minimal persona', tools }),
  )
  const names = promoted.tools.map((tool) => tool.name)
  assert.ok(names.includes('subagent'))
  assert.ok(!names.includes('web_search'))
})
