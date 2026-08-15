import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../zero-anchored-standard/context-defer.mjs'

function register(config = {}) {
  const listeners = {}
  const ctx = {
    on(event, callback, options) {
      listeners[event] = { callback, options }
    },
    logger: { warn(message) {} },
  }
  apply(ctx, config)
  return listeners
}

function emit(listeners, session, event) {
  listeners['session/event'].callback(session, event)
}

function inbox() {
  const queue = []
  return { queue, prepend(target, message) { queue.unshift(message) } }
}

async function preStep(listener, session, decision, agentInbox = inbox()) {
  const result = await listener.callback({ agent: { session, inbox: agentInbox } }, async () => decision)
  return { result, inbox: agentInbox }
}

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'context-defer')
})

test('re-queues matching recall messages until promotion', async () => {
  const listeners = register({
    promoteOn: 'assistant-message',
    deferSources: [{ kind: 'plugin', plugin: 'example.recall-provider', form: 'recall' }],
  })
  const listener = listeners['agent/pre-step']
  const user = { id: 'u', source: { kind: 'user' } }
  const recall = { id: 'r', source: { kind: 'plugin', plugin: 'example.recall-provider', form: 'recall' } }
  const session = { events: [], header: {} }
  const first = await preStep(listener, session, { kind: 'enter', messages: [user, recall] })
  assert.deepEqual(first.result.messages, [user])
  assert.deepEqual(first.inbox.queue, [recall])
  const promotion = { type: 'assistant/message' }
  session.events.push(promotion)
  emit(listeners, session, promotion)
  const promoted = await preStep(listener, session, { kind: 'enter', messages: [user, recall] })
  assert.deepEqual(promoted.result.messages, [user, recall])
  assert.deepEqual(promoted.inbox.queue, [])
})

test('deferred-only input is admitted instead of looping', async () => {
  const listener = register({
    promoteOn: 'assistant-message',
    deferSources: [{ kind: 'plugin' }],
  })['agent/pre-step']
  const recall = { id: 'r', source: { kind: 'plugin' } }
  const { result, inbox: agentInbox } = await preStep(listener, { events: [], header: {} }, { kind: 'enter', messages: [recall] })
  assert.deepEqual(result.messages, [recall])
  assert.deepEqual(agentInbox.queue, [])
})

test('compaction resets promotion so recalls are deferred again', async () => {
  const listeners = register({
    promoteOn: 'assistant-message',
    deferSources: [{ kind: 'plugin' }],
  })
  const listener = listeners['agent/pre-step']
  const recall = { id: 'r', source: { kind: 'plugin' } }
  const user = { id: 'u', source: { kind: 'user' } }
  const session = { events: [{ seq: 1, type: 'assistant/message' }], header: {} }

  const promoted = await preStep(listener, session, { kind: 'enter', messages: [user, recall] })
  assert.deepEqual(promoted.result.messages, [user, recall])

  const compaction = { seq: 2, type: 'compaction/end' }
  session.events.push(compaction)
  emit(listeners, session, compaction)
  const controlled = await preStep(listener, session, { kind: 'enter', messages: [user, recall] })
  assert.deepEqual(controlled.result.messages, [user])
  assert.deepEqual(controlled.inbox.queue, [recall])
})

test('invalid config fails at apply time', () => {
  assert.throws(() => register({ promoteOn: 'bogus' }), /promoteOn/)
  assert.throws(() => register({ deferSources: [{ kind: '' }] }), /deferSources/)
})
