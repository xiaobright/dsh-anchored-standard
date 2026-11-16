import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, DRIP_TEXT, name } from '../shared/cot-drip.mjs'

function register(config) {
  const listeners = {}
  const warns = []
  const ctx = {
    on(event, callback) {
      listeners[event] = callback
    },
    logger: {
      warn(message) {
        warns.push(message)
      },
    },
  }
  apply(ctx, config)
  assert.equal(typeof listeners['tools/post-execute'], 'function')
  return { listeners, warns }
}

function makeAgent(id = 's', header = {}) {
  return { session: { id, events: [], header } }
}

function postexecute(listener, agent = makeAgent()) {
  const result = { kind: 'accept', isError: false, value: {}, content: [] }
  return listener(
    { name: 'bash', arguments: { command: 'ls' }, agent, callId: 'c1', signal: new AbortController().signal },
    result,
    async () => ({ kind: 'accept' }),
  )
}

test('exports a diagnostic plugin name and default text', () => {
  assert.equal(name, 'cot-drip')
  assert.ok(DRIP_TEXT.includes('We'))
})

test('no reminder before the cadence point', async () => {
  const { listeners } = register({ every: 2 })
  const first = await postexecute(listeners['tools/post-execute'])
  assert.equal(first.additionalContexts, undefined)
})

test('the Nth tool result carries exactly one drip notice', async () => {
  const { listeners } = register({ every: 2 })
  await postexecute(listeners['tools/post-execute'])
  const second = await postexecute(listeners['tools/post-execute'])
  assert.ok(Array.isArray(second.additionalContexts))
  assert.equal(second.additionalContexts.length, 1)
  const notice = second.additionalContexts[0]
  assert.equal(notice.role, 'user')
  assert.equal(notice.content[0].text, DRIP_TEXT)
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.plugin, 'cot-drip')
  assert.equal(notice.source.form, 'notice')
})

test('maxPerTurn caps the reminders within one turn', async () => {
  const { listeners } = register({ every: 1, maxPerTurn: 1 })
  const first = await postexecute(listeners['tools/post-execute'])
  assert.equal(first.additionalContexts.length, 1)
  const second = await postexecute(listeners['tools/post-execute'])
  assert.equal(second.additionalContexts, undefined)
})

test('a new turn resets the cadence and the cap', async () => {
  const { listeners } = register({ every: 1, maxPerTurn: 1 })
  await postexecute(listeners['tools/post-execute'])
  await postexecute(listeners['tools/post-execute']) // capped
  const agent = makeAgent()
  listeners['session/event'](agent.session, { type: 'turn/start', data: { turn: 2 } })
  const fresh = await postexecute(listeners['tools/post-execute'], agent)
  assert.equal(fresh.additionalContexts.length, 1)
})

test('a chunk of a newer turn also resets the counters', async () => {
  const { listeners } = register({ every: 1, maxPerTurn: 1 })
  await postexecute(listeners['tools/post-execute'])
  const agent = makeAgent()
  listeners['session/event'](agent.session, {
    type: 'assistant/chunk',
    data: { turn: 5, step: 0, chunk: { type: 'text-delta', index: 0, text: 'We…' } },
  })
  const fresh = await postexecute(listeners['tools/post-execute'], agent)
  assert.equal(fresh.additionalContexts.length, 1)
})

test('every: 0 disables the drip entirely', async () => {
  const { listeners } = register({ every: 0 })
  for (let i = 0; i < 5; i += 1) {
    const decision = await postexecute(listeners['tools/post-execute'])
    assert.equal(decision.additionalContexts, undefined)
  }
})

test('subagents are not dripped by default', async () => {
  const { listeners } = register({ every: 1 })
  const agent = makeAgent('sub', { delegationDepth: 1 })
  const decision = await postexecute(listeners['tools/post-execute'], agent)
  assert.equal(decision.additionalContexts, undefined)
})

test('includeSubagents: true drips subagent calls too', async () => {
  const { listeners } = register({ every: 1, includeSubagents: true })
  const agent = makeAgent('sub2', { delegationDepth: 1 })
  const decision = await postexecute(listeners['tools/post-execute'], agent)
  assert.equal(decision.additionalContexts.length, 1)
})

test('executions without an agent are not counted or dripped', async () => {
  const { listeners } = register({ every: 1 })
  const decision = await listeners['tools/post-execute'](
    { name: 'bash', arguments: {}, signal: new AbortController().signal },
    { kind: 'accept', isError: false, value: {}, content: [] },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.additionalContexts, undefined)
})

test('a custom text is used for the notice', async () => {
  const { listeners } = register({ every: 1, text: 'Stay on plan.' })
  const decision = await postexecute(listeners['tools/post-execute'])
  assert.equal(decision.additionalContexts[0].content[0].text, 'Stay on plan.')
})

test('decision contexts from downstream listeners are preserved and extended', async () => {
  const { listeners } = register({ every: 1 })
  const downstream = { kind: 'accept', additionalContexts: [{ id: 'x', role: 'user', content: [], source: { kind: 'plugin', plugin: 'other' } }] }
  const decision = await listeners['tools/post-execute'](
    { name: 'bash', arguments: {}, agent: makeAgent(), signal: new AbortController().signal },
    { kind: 'accept', isError: false, value: {}, content: [] },
    async () => downstream,
  )
  assert.equal(decision.additionalContexts.length, 2)
  assert.equal(decision.additionalContexts[0].id, 'x')
  assert.equal(decision.additionalContexts[1].source.plugin, 'cot-drip')
})

test('non-accept decisions pass through untouched', async () => {
  const { listeners } = register({ every: 1 })
  const block = { kind: 'block', feedback: [] }
  const decision = await listeners['tools/post-execute'](
    { name: 'bash', arguments: {}, agent: makeAgent(), signal: new AbortController().signal },
    { kind: 'accept', isError: false, value: {}, content: [] },
    async () => block,
  )
  assert.equal(decision, block)
})

test('invalid cadence values fail at apply time', () => {
  assert.throws(() => register({ every: -1 }), /every/)
  assert.throws(() => register({ maxPerTurn: 0 }), /maxPerTurn/)
})

test('parallel tool calls respect maxPerTurn', async () => {
  const { listeners } = register({ every: 1, maxPerTurn: 1 })
  const agent = makeAgent()
  const calls = []
  for (let i = 0; i < 3; i += 1) {
    calls.push(listeners['tools/post-execute'](
      {
        name: 'bash',
        arguments: { command: 'ls' },
        agent,
        callId: `c${i}`,
        signal: new AbortController().signal,
      },
      { kind: 'accept', isError: false, value: {}, content: [] },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { kind: 'accept' }
      },
    ))
  }
  const decisions = await Promise.all(calls)
  assert.equal(
    decisions.filter((decision) => decision.additionalContexts?.length).length,
    1,
  )
})

test('a failed injection does not consume the per-turn cap', async () => {
  const { listeners } = register({ every: 1, maxPerTurn: 1 })
  const agent = makeAgent()
  const originalRandomUUID = crypto.randomUUID
  crypto.randomUUID = () => { throw new Error('no entropy') }
  try {
    const first = await postexecute(listeners['tools/post-execute'], agent)
    assert.equal(first.additionalContexts, undefined)
  } finally {
    crypto.randomUUID = originalRandomUUID
  }
  const second = await postexecute(listeners['tools/post-execute'], agent)
  assert.equal(second.additionalContexts.length, 1)
})
