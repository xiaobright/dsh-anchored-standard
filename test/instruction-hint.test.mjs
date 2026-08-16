import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../shared/instruction-hint.mjs'

const PROJ_FILES = ['AGENTS.md', 'CLAUDE.md']
const GLOBAL_FILES = []

function register(header = {}) {
  const listeners = {}
  const hookOptions = {}
  const fs = {
    async resolve(target) {
      return target
    },
    async stat(target) {
      const base = target.replace(/\\/g, '/').split('/').pop()
      if (PROJ_FILES.includes(base)) return { type: 'file' }
      if (GLOBAL_FILES.includes(base)) return { type: 'file' }
      if (base === '.git' || base === '.hg' || base === '.svn') return { type: 'directory' }
      throw new Error('ENOENT')
    },
  }
  const ctx = {
    on(event, callback, options) {
      listeners[event] = callback
      hookOptions[event] = options
    },
    get(service) {
      if (service === 'fs') return fs
      return undefined
    },
    logger: { warn() {} },
  }
  apply(ctx, { promoteOn: 'either' })
  return { listeners, hookOptions }
}

const session = (events, header = {}) => ({ id: 's', events, header: { cwd: 'C:/work', ...header } })

const decision = () => ({ kind: 'enter', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }] })

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'instruction-hint')
})

test('pre-promotion requests get NO hint', async () => {
  const { listeners } = register()
  const d = decision()
  const result = await listeners['agent/pre-step'](
    { agent: { session: session([]) } },
    async () => d,
  )
  assert.equal(result, d)
})

test('after promotion ONE hint is injected once per session', async () => {
  const { listeners } = register()
  const agent = { session: session([{ type: 'assistant/message', seq: 1, data: {} }]) }
  const first = await listeners['agent/pre-step']({ agent }, async () => decision())
  assert.equal(first.messages.length, 2)
  const hint = first.messages[1]
  assert.equal(hint.source.kind, 'instruction-hint')
  assert.match(hint.content[0].text, /AGENTS\.md, CLAUDE\.md/)
  // Second call for the same session: no duplicate hint.
  const second = await listeners['agent/pre-step']({ agent }, async () => decision())
  assert.equal(second.messages.length, 1)
})

test('no instruction files found → no hint message', async () => {
  const listeners = {}
  const fs = {
    async resolve(target) { return target },
    async stat() { throw new Error('ENOENT') },
  }
  const ctx = {
    on(event, callback) { listeners[event] = callback },
    get(service) { return service === 'fs' ? fs : undefined },
    logger: { warn() {} },
  }
  apply(ctx, { promoteOn: 'either' })
  const agent = { session: session([{ type: 'assistant/message', seq: 1, data: {} }]) }
  const result = await listeners['agent/pre-step']({ agent }, async () => decision())
  assert.equal(result.messages.length, 1)
})

test('missing fs service degrades to no hint (never throws)', async () => {
  const listeners = {}
  const ctx = {
    on(event, callback) { listeners[event] = callback },
    get() { return undefined },
    logger: { warn() {} },
  }
  apply(ctx, { promoteOn: 'either' })
  const agent = { session: session([{ type: 'assistant/message', seq: 1, data: {} }]) }
  const result = await listeners['agent/pre-step']({ agent }, async () => decision())
  assert.equal(result.messages.length, 1)
})

test('the hint registers with prepend', () => {
  const { hookOptions } = register()
  assert.deepEqual(hookOptions['agent/pre-step'], { prepend: true })
})

test('regression: AGENTS.md below the git root still gets hinted (chain probing)', async () => {
  // The observed failure mode: a session cwd nested below the git root
  // carried AGENTS.md while the root itself did not. Root-only probing
  // found nothing, so the hint silently never fired — the plugin's own
  // docstring promises "walking up from the session cwd to the project
  // root", and this pins that behavior.
  const listeners = {}
  const files = new Set(['/work/project/.git', '/work/project/sub/AGENTS.md'])
  const fs = {
    async resolve(target) { return target },
    async stat(target) {
      const path = target.replace(/\\/g, '/')
      if (!files.has(path)) throw new Error('ENOENT')
      return path.endsWith('.git') ? { type: 'directory' } : { type: 'file' }
    },
  }
  const ctx = {
    on(event, callback) { listeners[event] = callback },
    get(service) { return service === 'fs' ? fs : undefined },
    logger: { warn() {} },
  }
  apply(ctx, { promoteOn: 'either' })
  const agent = { session: session([{ type: 'tool/call', seq: 1, data: {} }], { cwd: '/work/project/sub' }) }
  const result = await listeners['agent/pre-step']({ agent }, async () => decision())
  assert.equal(result.messages.length, 2, 'hint must be injected when the file lives below the git root')
  assert.match(result.messages[1].content[0].text, /sub\/AGENTS\.md/)
  assert.match(result.messages[1].content[0].text, /project root: \/work\/project/)
})
