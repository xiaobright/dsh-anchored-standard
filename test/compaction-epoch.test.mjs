import assert from 'node:assert/strict'
import test from 'node:test'

import { createEpochPromotion } from '../preset/compaction-epoch.mjs'

const session = (events, header = {}, id = 's') => ({ id, events, header })

test('no events: un-promoted, boundary -1', () => {
  const promotion = createEpochPromotion(['tool/call', 'assistant/message'])
  const status = promotion.status({ session: session([]) })
  assert.equal(status.promoted, false)
  assert.equal(status.boundary, -1)
})

test('a promotion signal before any compaction promotes', () => {
  const promotion = createEpochPromotion(['tool/call', 'assistant/message'])
  const s = session([{ type: 'assistant/message', seq: 0, data: {} }])
  assert.equal(promotion.status({ session: s }).promoted, true)
})

test('incremental observe promotes O(1) after the cold scan', () => {
  const promotion = createEpochPromotion(['assistant/message'])
  const s = session([])
  assert.equal(promotion.status({ session: s }).promoted, false)
  promotion.observe(s, { type: 'assistant/message', seq: 1, data: {} })
  assert.equal(promotion.status({ session: s }).promoted, true)
  // observe is a no-op on a session this process never scanned
  const foreign = session([], {}, 'foreign')
  promotion.observe(foreign, { type: 'assistant/message', seq: 1, data: {} })
  assert.equal(promotion.status({ session: foreign }).promoted, false)
})

test('a compaction resets promotion regardless of earlier signals', () => {
  const promotion = createEpochPromotion(['tool/call', 'assistant/message'])
  const s = session([
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ])
  const status = promotion.status({ session: s })
  assert.equal(status.promoted, false)
  assert.equal(status.boundary, 2)
})

test('only signals AFTER the compaction boundary count (old signals stay dead)', () => {
  const promotion = createEpochPromotion(['tool/call', 'assistant/message'])
  const s = session([
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'tool/call', seq: 2, data: {} },
    { type: 'compaction/end', seq: 3 },
  ])
  assert.equal(promotion.status({ session: s }).promoted, false)
  // A NEW signal past the boundary re-promotes.
  promotion.observe(s, { type: 'assistant/message', seq: 4, data: {} })
  assert.equal(promotion.status({ session: s }).promoted, true)
})

test('observe across the boundary flips the phase immediately', () => {
  const promotion = createEpochPromotion(['assistant/message'])
  const s = session([{ type: 'assistant/message', seq: 1, data: {} }])
  assert.equal(promotion.status({ session: s }).promoted, true)
  promotion.observe(s, { type: 'compaction/end', seq: 2 })
  assert.equal(promotion.status({ session: s }).promoted, false)
  promotion.observe(s, { type: 'assistant/message', seq: 3, data: {} })
  assert.equal(promotion.status({ session: s }).promoted, true)
})

test('multiple compactions: the LAST boundary wins', () => {
  const promotion = createEpochPromotion(['assistant/message'])
  const s = session([
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
    { type: 'assistant/message', seq: 3, data: {} },
    { type: 'compaction/end', seq: 4 },
  ])
  const status = promotion.status({ session: s })
  assert.equal(status.promoted, false)
  assert.equal(status.boundary, 4)
})

test('subagents (delegationDepth > 0) are always promoted', () => {
  const promotion = createEpochPromotion(['tool/call'])
  const s = session([], { delegationDepth: 1 })
  assert.equal(promotion.status({ session: s }).promoted, true)
})

test('undefined agent or session is always promoted (defensive)', () => {
  const promotion = createEpochPromotion(['tool/call'])
  assert.equal(promotion.status(undefined).promoted, true)
  assert.equal(promotion.status({ session: undefined }).promoted, true)
})

test('a session header without delegationDepth is treated as top-level', () => {
  const promotion = createEpochPromotion(['tool/call'])
  const s = session([], {})
  assert.equal(promotion.status({ session: s }).promoted, false)
})

test('forked sessions ignore inherited parent events below seedLength on cold scan', () => {
  const promotion = createEpochPromotion(['tool/call', 'assistant/message'])
  const forked = {
    id: 'forked',
    header: { seedLength: 1 },
    events: [
      { seq: 0, type: 'assistant/message', data: {} },
      { seq: 1, type: 'tool/call', data: {} },
    ],
  }
  const status = promotion.status({ session: forked })
  assert.equal(status.promoted, true)
  assert.equal(status.boundary, -1)
})

test('forked sessions ignore inherited parent events below seedLength incrementally', () => {
  const promotion = createEpochPromotion(['assistant/message'])
  const forked = { id: 'forked', header: { seedLength: 2 }, events: [] }
  assert.equal(promotion.status({ session: forked }).promoted, false)
  promotion.observe(forked, { seq: 1, type: 'assistant/message', data: {} })
  assert.equal(promotion.status({ session: forked }).promoted, false)
  promotion.observe(forked, { seq: 2, type: 'assistant/message', data: {} })
  assert.equal(promotion.status({ session: forked }).promoted, true)
})

test('a compaction inherited from the parent below seedLength is ignored', () => {
  const promotion = createEpochPromotion(['assistant/message'])
  const forked = {
    id: 'forked',
    header: { seedLength: 2 },
    events: [
      { seq: 0, type: 'assistant/message', data: {} },
      { seq: 1, type: 'compaction/end' },
    ],
  }
  const status = promotion.status({ session: forked })
  assert.equal(status.promoted, false)
  assert.equal(status.boundary, -1)
})

test('promotion state is keyed by session object, not session id', () => {
  const promotion = createEpochPromotion(['assistant/message'])
  const promoted = { id: 'same-id', events: [{ type: 'assistant/message' }], header: {} }
  const fresh = { id: 'same-id', events: [], header: {} }
  assert.equal(promotion.status({ session: promoted }).promoted, true)
  assert.equal(promotion.status({ session: fresh }).promoted, false)
})
