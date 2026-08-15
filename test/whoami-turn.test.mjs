import assert from 'node:assert/strict'
import test from 'node:test'

import { ANCHOR_TEXT, apply, name } from '../whoami-standard/whoami-turn.mjs'
import { apply as applyZeroBootstrap, name as zeroBootstrapName } from '../whoami-standard/zero-tool-bootstrap.mjs'

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
  assert.equal(name, 'whoami-turn')
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
  assert.equal(prepends[0].message.source.plugin, 'whoami-turn')
})

test('config text overrides the default anchor', () => {
  const custom = 'Who are you?'
  const listener = register({ text: custom })
  const { subject, prepends } = agent()
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends[0].message.content[0].text, custom)
})

test('plugin-sourced messages never re-anchor', () => {
  const listener = register()
  const { subject, prepends } = agent()
  listener({ agent: subject, message: { source: { kind: 'plugin', plugin: 'whoami-turn' } } })
  assert.equal(prepends.length, 0)
})

test('sessions with a prior user message are not anchored again', () => {
  const listener = register()
  const { subject, prepends } = agent({ events: [{ type: 'user/message' }] })
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 0)
})

test('subagents are never anchored', () => {
  const listener = register()
  const { subject, prepends } = agent({ depth: 1 })
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 0)
})

test('whoami zero-tool bootstrap supports promotedCatalog: full', async () => {
  assert.equal(zeroBootstrapName, 'zero-tool-bootstrap')
  const listeners = {}
  const ctx = {
    on(event, callback) {
      listeners[event] = callback
    },
    logger: { warn() {} },
  }
  applyZeroBootstrap(ctx, { promotedCatalog: 'full' })
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]
  const first = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session: { id: 's', events: [], header: {} } } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(first.tools, [])
  const promoted = await listeners['system-prompt/assemble'](
    undefined,
    { agent: { session: { id: 's2', events: [{ type: 'assistant/message' }], header: {} } } },
    async () => ({ system: 'minimal persona', tools }),
  )
  assert.deepEqual(promoted.tools, tools)
  assert.throws(() => applyZeroBootstrap({ ...ctx, on() {} }, { promotedCatalog: 'bogus' }), /promotedCatalog/)
})
