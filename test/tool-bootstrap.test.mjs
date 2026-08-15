import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../preset/tool-bootstrap.mjs'

const config = {
  bootstrapTools: ['bash', 'str_replace_editor'],
}

function register(cfg = config) {
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
  apply(ctx, cfg)
  return { listeners, hookOptions, warns }
}

const agent = (events, id = 's') => ({ session: { id, events } })

function assemble(listener, events, tools, id = 's') {
  return listener(undefined, { agent: agent(events, id) }, async () => ({ system: 'minimal persona', tools }))
}

function request(listener, events, resolved, id = 's') {
  return listener({ agent: agent(events, id), turn: 1, step: 1 }, async () => resolved)
}

function prestep(listener, events, messages, id = 's') {
  return listener({ agent: agent(events, id), turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
}

const userMessage = { id: 'u', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
const instructionMessage = { id: 'i', content: [], source: { kind: 'agent-instructions' } }
const catalogMessage = { id: 'c', content: [], source: { kind: 'skill-catalog' } }
const gestureMessage = { id: 'g', content: [], source: { kind: 'skill-invocation' } }
const pluginMessage = { id: 'p', content: [], source: { kind: 'plugin' } }

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'anchored-tool-bootstrap')
})

test('first request exposes exactly the Minimal tool pair', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' },
    { name: 'str_replace_editor' },
    { name: 'pwsh' },
    { name: 'read' },
    { name: 'edit' },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('a durable tool call promotes the resident catalog', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'edit' }, { name: 'grep' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call', data: { name: 'bash' } }], tools)
  // Promoted: the bootstrap pair only — read/edit/grep are NOT resident
  // (bash + str_replace_editor cover file work; heavier tools are one
  // dev_tool_search away).
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('a first assistant message promotes the resident catalog (no tool call needed)', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message', data: {} }], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('sessions derive promotion independently from their own events', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, 'a')
  const fresh = await assemble(listeners['system-prompt/assemble'], [], tools, 'b')
  assert.deepEqual(promoted.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
  assert.deepEqual(fresh.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('promotion is memoized per session id within one process', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const first = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, 'memo')
  assert.deepEqual(first.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
  // Same session id, events now empty: the cached decision still promotes.
  const second = await assemble(listeners['system-prompt/assemble'], [], tools, 'memo')
  assert.deepEqual(second.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('promoteOn tool-call requires a tool call, not just a reply', async () => {
  const { listeners } = register({ ...config, promoteOn: 'tool-call' })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const replyOnly = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, 'a')
  assert.deepEqual(replyOnly.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
  const withCall = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, 'b')
  assert.deepEqual(withCall.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('promoteOn assistant-message promotes after any first reply', async () => {
  const { listeners } = register({ ...config, promoteOn: 'assistant-message' })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, 'a')
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('a missing bootstrap tool degrades gracefully to the full catalog', async () => {
  const { listeners, warns } = register()
  const tools = [{ name: 'str_replace_editor' }, { name: 'edit' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools, tools)
  assert.ok(warns.length >= 1)
})

test('invalid bootstrapTools values fail at apply time', () => {
  assert.throws(() => register({ ...config, bootstrapTools: [] }), /bootstrapTools/)
  assert.throws(() => register({ ...config, bootstrapTools: ['bash', 42] }), /bootstrapTools/)
})

test('invalid promoteOn values fail at apply time', () => {
  assert.throws(() => register({ ...config, promoteOn: 'bogus' }), /promoteOn/)
})

test('without bootstrapMaxTokens the adapter default flows (no agent/request listener)', async () => {
  const { listeners } = register()
  assert.equal(listeners['agent/request'], undefined)
})

test('with bootstrapMaxTokens the first request is capped', async () => {
  const { listeners, hookOptions } = register({ ...config, bootstrapMaxTokens: 1024 })
  assert.equal(hookOptions['agent/request']?.prepend, true)
  const resolved = await request(listeners['agent/request'], [], { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(resolved.maxTokens, 1024)
  assert.equal(resolved.provider, 'deepseek-official')
})

test('with bootstrapMaxTokens, after promotion the injected cap is stripped so the default returns', async () => {
  const { listeners } = register({ ...config, bootstrapMaxTokens: 1024 })
  const resolved = await request(listeners['agent/request'], [{ type: 'tool/call' }], { provider: 'x', model: 'y', maxTokens: 1024 })
  assert.equal(resolved.maxTokens, undefined)
})

test('with bootstrapMaxTokens, after promotion a different maxTokens is preserved', async () => {
  const { listeners } = register({ ...config, bootstrapMaxTokens: 1024 })
  const resolved = await request(listeners['agent/request'], [{ type: 'tool/call' }], { provider: 'x', model: 'y', maxTokens: 256000 })
  assert.equal(resolved.maxTokens, 256000)
})

test('invalid bootstrapMaxTokens fails at apply time', () => {
  assert.throws(() => register({ ...config, bootstrapMaxTokens: 0 }), /bootstrapMaxTokens/)
})

test('pre-step filter registers with prepend before every other listener', () => {
  const { hookOptions } = register()
  assert.equal(hookOptions['agent/pre-step']?.prepend, true)
})

test('bootstrap pre-step strips skill-catalog and agent-instructions messages', async () => {
  const { listeners } = register()
  const messages = [
    { id: 'm1', content: [{ type: 'text', text: 'user message' }] },
    { id: 'm2', content: [{ type: 'text', text: '<system-reminder>skills...</system-reminder>' }], source: { kind: 'skill-catalog' } },
    { id: 'm3', content: [{ type: 'text', text: '# AGENTS.md content' }], source: { kind: 'agent-instructions' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages.map((message) => message.id), ['m1'])
})

test('bootstrap pre-step strips messages from suppressedContextPlugins', async () => {
  const { listeners } = register({ ...config, suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'] })
  const messages = [
    { id: 'u', content: [{ type: 'text', text: 'user message' }] },
    { id: 'snap', content: [{ type: 'text', text: 'runtime snapshot' }], source: { kind: 'user/message', plugin: '@deepseek-ai/dsh-system-prompt' } },
    { id: 'k', content: [{ type: 'text', text: 'skill catalog' }], source: { kind: 'skill-catalog' } },
    { id: 'p', content: [{ type: 'text', text: 'other plugin' }], source: { kind: 'plugin', plugin: 'other-plugin' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages.map((message) => message.id), ['u', 'p'])
})

test('suppressedContextPlugins is configurable and default-empty', async () => {
  const { listeners } = register({ ...config, suppressedContextPlugins: ['my-plugin'] })
  const messages = [
    { id: 'u', content: [] },
    { id: 'm', content: [], source: { kind: 'plugin', plugin: 'my-plugin' } },
    { id: 'other', content: [], source: { kind: 'plugin', plugin: 'other-plugin' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.deepEqual(decision.messages.map((message) => message.id), ['u', 'other'])
})

test('an empty suppressedContextPlugins list keeps the plugin filter off while sources still strip', async () => {
  const { listeners } = register({ ...config, suppressedContextPlugins: [] })
  const messages = [
    { id: 'u', content: [] },
    { id: 'k', content: [], source: { kind: 'skill-catalog' } },
    { id: 'snap', content: [], source: { kind: 'user/message', plugin: '@deepseek-ai/dsh-system-prompt' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  // skill-catalog (source) still stripped; runtime snapshot (plugin-only) kept
  assert.deepEqual(decision.messages.map((message) => message.id), ['u', 'snap'])
})

test('invalid suppressedContextPlugins values fail at apply time', () => {
  assert.throws(() => register({ ...config, suppressedContextPlugins: 'x' }), /suppressedContextPlugins/)
  assert.throws(() => register({ ...config, suppressedContextPlugins: ['x', 42] }), /suppressedContextPlugins/)
})

test('bootstrap strip preserves user skill gestures and other plugin messages', async () => {
  const { listeners } = register()
  const decision = await prestep(listeners['agent/pre-step'], [], [
    userMessage,
    instructionMessage,
    catalogMessage,
    gestureMessage,
    pluginMessage,
  ])
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages.map((message) => message.id), ['u', 'g', 'p'])
})

test('promoted pre-step keeps every injected context message', async () => {
  const { listeners } = register()
  const messages = [userMessage, instructionMessage, catalogMessage, pluginMessage]
  const decision = await prestep(listeners['agent/pre-step'], [{ type: 'tool/call' }], messages)
  assert.equal(decision.messages, messages)
})

test('a text-only first reply promotes the context injections too', async () => {
  const { listeners } = register()
  const stripped = await prestep(listeners['agent/pre-step'], [], [userMessage, instructionMessage, catalogMessage], 'a')
  assert.deepEqual(stripped.messages.map((message) => message.id), ['u'])
  // Distinct session id: the first (un-promoted) scan must not shadow this one.
  const kept = await prestep(listeners['agent/pre-step'], [{ type: 'assistant/message' }], [userMessage, instructionMessage], 'b')
  assert.deepEqual(kept.messages.map((message) => message.id), ['u', 'i'])
})

test('reject decisions pass through the context filter untouched', async () => {
  const { listeners } = register()
  const decision = { kind: 'reject', messages: [userMessage, instructionMessage] }
  const result = await listeners['agent/pre-step'](
    { agent: agent([]), turn: 1, step: 1 },
    async () => decision,
  )
  assert.equal(result, decision)
})

test('suppressedContextSources is configurable', async () => {
  const { listeners } = register({ ...config, suppressedContextSources: ['skill-invocation'] })
  const decision = await prestep(listeners['agent/pre-step'], [], [userMessage, instructionMessage, catalogMessage, gestureMessage])
  assert.deepEqual(decision.messages.map((message) => message.id), ['u', 'i', 'c'])
})

test('an empty suppressedContextSources disables the context filter', async () => {
  const { listeners } = register({ ...config, suppressedContextSources: [] })
  const messages = [userMessage, instructionMessage, catalogMessage]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.equal(decision.messages, messages)
})

test('invalid suppressedContextSources values fail at apply time', () => {
  assert.throws(() => register({ ...config, suppressedContextSources: 'agent-instructions' }), /suppressedContextSources/)
  assert.throws(() => register({ ...config, suppressedContextSources: ['agent-instructions', 42] }), /suppressedContextSources/)
})

test('the pre-step strip and the budget cap both register with prepend', () => {
  const { hookOptions } = register({ ...config, bootstrapMaxTokens: 1024 })
  assert.deepEqual(hookOptions['agent/pre-step'], { prepend: true })
  assert.deepEqual(hookOptions['agent/request'], { prepend: true })
})

// ── local additions: resident set, dev_tool_search unlock, compaction ──────

test('the promoted resident set includes the discovery tools when available', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'edit' },
    { name: 'dev_tool_search' }, { name: 'skill_search' }, { name: 'skill_load' }, { name: 'web_search' },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    'bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor',
  ])
})

test('dev_tool_search unlocks tools durably (resume-safe from tool/call events)', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' },
    { name: 'skill_search' }, { name: 'skill_load' }, { name: 'web_search' }, { name: 'subagent' },
  ]
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search","subagent"]}' } },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  const names = result.tools.map((tool) => tool.name)
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('subagent'))
})

test('malformed dev_tool_search arguments are ignored, not fatal', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' }]
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: 'not json' } },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'dev_tool_search', 'str_replace_editor'])
})

test('post-compaction falls back to the bootstrap pair plus compactionTools', async () => {
  const { listeners } = register({ ...config, compactionTools: ['read', 'todo_write'] })
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'todo_write' }, { name: 'web_search' },
  ]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'read', 'str_replace_editor', 'todo_write'])
})

test('post-compaction without compactionTools stays on the bootstrap pair', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
})

test('a compaction resets promotion; a new signal after the boundary re-promotes', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const postCompaction = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(postCompaction.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
  // The live harness feeds new events through session/event; emulate that.
  listeners['session/event']({ id: 's', events }, { type: 'tool/call', seq: 3, data: { name: 'bash' } })
  const rePromoted = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(rePromoted.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
})

test('pre-compaction promotion signals do not re-promote after a compaction', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  // The assistant/message (seq 1) sits BEFORE the compaction boundary (seq 2):
  // only a NEW signal past the boundary counts.
  const result = await assemble(listeners['system-prompt/assemble'], [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
})

test('subagents (delegationDepth > 0) are always promoted', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const result = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session: { id: 'sub', events: [], header: { delegationDepth: 1 } } } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
})

test('invalid compactionTools values fail at apply time', () => {
  assert.throws(() => register({ ...config, compactionTools: [] }), /compactionTools/)
  assert.throws(() => register({ ...config, compactionTools: ['read', 42] }), /compactionTools/)
})

test('unknown config keys reject at apply time', () => {
  assert.throws(() => register({ ...config, promoteOnn: 'either' }), /unknown config key/)
  assert.throws(() => register({ bootstrapTools: ['bash'], commonTools: ['read'] }), /unknown config key/)
  assert.throws(() => register(null), /config must be an object/)
  assert.throws(() => register([]), /config must be an object/)
})
