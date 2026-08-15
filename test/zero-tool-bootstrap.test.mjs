import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../zero-anchored-standard/zero-tool-bootstrap.mjs'

function register(config) {
  const listeners = {}
  const hookOptions = {}
  const warns = []
  const ctx = {
    on(event, callback, options) {
      listeners[event] = callback
      hookOptions[event] = options
    },
    logger: {
      warn(message) {
        warns.push(message)
      },
    },
  }
  apply(ctx, config)
  assert.equal(typeof listeners['system-prompt/assemble'], 'function')
  return { listeners, hookOptions, warns }
}

function assemble(listener, events, tools, header = {}, id = 's') {
  return listener(
    undefined,
    { agent: { session: { id, events, header } } },
    async () => ({ system: 'minimal persona', tools }),
  )
}

function prestep(listener, events, messages, id = 's') {
  return listener({ agent: { session: { id, events, header: {} } } }, async () => ({ kind: 'enter', messages }))
}

const userMessage = { id: 'u', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
const instructionMessage = { id: 'i', content: [], source: { kind: 'agent-instructions' } }
const catalogMessage = { id: 'c', content: [], source: { kind: 'skill-catalog' } }

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'zero-tool-bootstrap')
})

test('the first top-level request exposes zero tools', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools, [])
})

test('a durable assistant message promotes the resident catalog', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }, { name: 'grep' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message', data: {} }], tools)
  // Promoted resident: the shells + str_replace_editor + discovery tools —
  // read/edit/grep are NOT resident (bash covers file work).
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash'])
})

test('the promoted resident set includes discovery tools and str_replace_editor when available', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' }, { name: 'pwsh' }, { name: 'str_replace_editor' },
    { name: 'dev_tool_search' }, { name: 'skill_search' }, { name: 'skill_load' }, { name: 'web_search' },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message', data: {} }], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    'bash', 'dev_tool_search', 'pwsh', 'skill_load', 'skill_search', 'str_replace_editor',
  ])
})

test('dev_tool_search unlocks tools durably (resume-safe from tool/call events)', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'dev_tool_search' }, { name: 'web_search' }, { name: 'subagent' }]
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search"]}' } },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  const names = result.tools.map((tool) => tool.name)
  assert.ok(names.includes('web_search'))
  assert.ok(!names.includes('subagent'))
})

test('subagents see the resident catalog from their first request', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools, { delegationDepth: 1 })
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash'])
})

test('an assembly outside an agent keeps the resident catalog', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }]
  const result = await listeners['system-prompt/assemble'](undefined, { agent: undefined }, async () => ({ tools }))
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash'])
})

test('promotion is memoized per session object within one process', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const session = { id: 'memo', events: [{ type: 'assistant/message', data: {} }], header: {} }
  const promoted = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(promoted.tools.map((tool) => tool.name), ['bash'])
  // Same session object, events now empty: the cached decision still promotes.
  session.events = []
  const again = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(again.tools.map((tool) => tool.name), ['bash'])
  // A DIFFERENT session object with the same id must not inherit the cache.
  const fresh = { id: 'memo', events: [], header: {} }
  const cold = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session: fresh } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(cold.tools, [])
})

test('sessions derive promotion independently from their own events', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, {}, 'a')
  const fresh = await assemble(listeners['system-prompt/assemble'], [], tools, {}, 'b')
  assert.deepEqual(promoted.tools.map((tool) => tool.name), ['bash'])
  assert.deepEqual(fresh.tools, [])
})

test('post-compaction falls back to shell plus compactionTools (not the zero-tool anchor)', async () => {
  const { listeners } = register({ compactionTools: ['read', 'todo_write'] })
  const tools = [{ name: 'bash' }, { name: 'pwsh' }, { name: 'read' }, { name: 'todo_write' }, { name: 'web_search' }]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  // All available shells stay; web_search is not in the work set.
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'pwsh', 'read', 'todo_write'])
})

test('post-compaction without compactionTools stays zero-tool until re-promotion', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(result.tools, [])
})

test('a compaction resets promotion; a new message after the boundary re-promotes', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }]
  const session = {
    id: 's',
    header: {},
    events: [
      { type: 'assistant/message', seq: 1, data: {} },
      { type: 'compaction/end', seq: 2 },
    ],
  }
  const postCompaction = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(postCompaction.tools, [])
  // The live harness feeds new events through session/event; emulate that on the SAME session object.
  const rePromotion = { type: 'assistant/message', seq: 3, data: {} }
  session.events.push(rePromotion)
  listeners['session/event'](session, rePromotion)
  const rePromoted = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(rePromoted.tools.map((tool) => tool.name), ['bash'])
})

test('the controlled phase strips skill-catalog and agent-instructions messages', async () => {
  const { listeners } = register()
  const decision = await prestep(listeners['agent/pre-step'], [], [userMessage, instructionMessage, catalogMessage])
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages.map((message) => message.id), ['u'])
})

test('promoted pre-step keeps every injected context message', async () => {
  const { listeners } = register()
  const messages = [userMessage, instructionMessage, catalogMessage]
  const decision = await prestep(listeners['agent/pre-step'], [{ type: 'assistant/message' }], messages)
  assert.equal(decision.messages, messages)
})

test('an empty suppressedContextSources disables the context filter', async () => {
  const { listeners } = register({ suppressedContextSources: [] })
  const messages = [userMessage, instructionMessage, catalogMessage]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.equal(decision.messages, messages)
})

test('the pre-step strip registers with prepend', () => {
  const { hookOptions } = register()
  assert.deepEqual(hookOptions['agent/pre-step'], { prepend: true })
})

test('invalid compactionTools values fail at apply time', () => {
  assert.throws(() => register({ compactionTools: [] }), /compactionTools/)
  assert.throws(() => register({ compactionTools: ['read', 42] }), /compactionTools/)
})

test('promotedCatalog: full restores the complete catalog after promotion', async () => {
  const { listeners } = register({ promotedCatalog: 'full' })
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }, { name: 'web_search' }]
  const first = await assemble(listeners['system-prompt/assemble'], [], tools, {}, 'first')
  assert.deepEqual(first.tools, [])
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message', data: {} }], tools, {}, 'promoted')
  assert.deepEqual(promoted.tools, tools)
})

test('promotedCatalog defaults to resident and rejects invalid values', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }]
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools)
  assert.deepEqual(promoted.tools.map((tool) => tool.name), ['bash'])
  assert.throws(() => register({ promotedCatalog: 'bogus' }), /promotedCatalog/)
})

test('forked sessions ignore inherited promotion and unlock events below seedLength', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' },
    { name: 'dev_tool_search' }, { name: 'skill_search' }, { name: 'skill_load' },
    { name: 'web_search' }, { name: 'subagent' },
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
  assert.ok(names.includes('subagent'), 'own unlock after the seed boundary is resident')
  assert.ok(!names.includes('web_search'), 'parent unlock below the seed boundary stays locked')
})
