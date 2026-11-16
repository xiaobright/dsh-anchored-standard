import assert from 'node:assert/strict'
import test from 'node:test'

import { ANCHOR_TEXT, apply, name } from '../shared/anchor-turn.mjs'

function register(config = {}) {
  let listener
  const ctx = {
    on(event, callback) {
      assert.equal(event, 'agent/inbox/inserted')
      listener = callback
    },
  }
  apply(ctx, config)
  assert.equal(typeof listener, 'function')
  return listener
}

function agent({ depth = 0, events = [] } = {}) {
  const prepends = []
  const subject = {
    session: { header: { delegationDepth: depth }, events },
    inbox: {
      prepend(target, message) {
        prepends.push({ target, message })
      },
    },
  }
  return { subject, prepends }
}

test('exports a diagnostic plugin name and default anchor text', () => {
  assert.equal(name, 'anchor-turn')
  assert.equal(typeof ANCHOR_TEXT, 'string')
  assert.ok(ANCHOR_TEXT.length > 0)
})

test('the first user message prepends the default anchor ahead of it', () => {
  const listener = register()
  const { subject, prepends } = agent()
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 1)
  assert.equal(prepends[0].target, 'next-turn')
  assert.equal(prepends[0].message.role, 'user')
  assert.equal(prepends[0].message.content[0].text, ANCHOR_TEXT)
  assert.equal(prepends[0].message.source.plugin, 'anchor-turn')
})

test('config text overrides the default anchor', () => {
  const custom = 'Custom anchor.'
  const listener = register({ text: custom })
  const { subject, prepends } = agent()
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends[0].message.content[0].text, custom)
})

test('the whoami preset text seeds a self-introduction anchor', () => {
  const listener = register({ text: '你是谁' })
  const { subject, prepends } = agent()
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 1)
  assert.equal(prepends[0].message.content[0].text, '你是谁')
})

test('plugin-sourced messages never re-anchor', () => {
  const listener = register()
  const { subject, prepends } = agent()
  listener({ agent: subject, message: { source: { kind: 'plugin', plugin: 'anchor-turn' } } })
  assert.equal(prepends.length, 0)
})

test('sessions with a prior user message are not anchored again', () => {
  const listener = register()
  const { subject, prepends } = agent({ events: [{ type: 'user/message' }] })
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 0)
})

test('subagents are never anchored by default', () => {
  const listener = register()
  const { subject, prepends } = agent({ depth: 1 })
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 0)
})

test('subagents are anchored when includeSubagents is true', () => {
  const listener = register({ includeSubagents: true })
  const { subject, prepends } = agent({ depth: 1 })
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 1)
  assert.equal(prepends[0].message.content[0].text, ANCHOR_TEXT)
})

test('two queued user messages before the first turn seed only one anchor', () => {
  const listener = register()
  const { subject, prepends } = agent()
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 1)
})
