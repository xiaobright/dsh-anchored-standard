import assert from 'node:assert/strict'
import test from 'node:test'

import { createFirstAssistantCanceller } from '../verify/first-assistant-canceller.mjs'

/** Minimal fake agent surface: session events plus a cancel recorder. */
function agent(events = []) {
  const calls = []
  return {
    calls,
    session: { events },
    cancel(reason) {
      calls.push(reason)
    },
  }
}

/** In-memory timer pair so tests drive ticks deterministically. */
function fakeTimers() {
  let nextId = 1
  const timers = new Map()
  return {
    timers,
    setInterval(fn, ms) {
      const id = nextId += 1
      timers.set(id, { fn, ms })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },
    fireAll() {
      for (const timer of [...timers.values()]) timer.fn()
    },
  }
}

test('disabled mode schedules no timer and returns no stop handle', () => {
  const timers = fakeTimers()
  const subject = agent([{ type: 'assistant/message', seq: 10 }])
  const stop = createFirstAssistantCanceller({
    agent: subject,
    firstSeq: 5,
    enabled: false,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  })
  assert.equal(stop, undefined)
  assert.equal(timers.timers.size, 0)
  timers.fireAll()
  assert.deepEqual(subject.calls, [])
})

test('enabled mode cancels once when a durable assistant message at/after firstSeq appears', () => {
  const timers = fakeTimers()
  const subject = agent()
  const stop = createFirstAssistantCanceller({
    agent: subject,
    firstSeq: 10,
    enabled: true,
    intervalMs: 100,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  })
  assert.equal(timers.timers.size, 1)
  assert.deepEqual(subject.calls, [])
  subject.session.events.push({ type: 'assistant/message', seq: 10 })
  timers.fireAll()
  timers.fireAll()
  assert.equal(subject.calls.length, 1)
  assert.deepEqual(subject.calls[0], { kind: 'user' })
  stop.stop()
})

test('events before firstSeq never cancel', () => {
  const timers = fakeTimers()
  const subject = agent([{ type: 'assistant/message', seq: 9 }])
  createFirstAssistantCanceller({
    agent: subject,
    firstSeq: 10,
    enabled: true,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  })
  timers.fireAll()
  assert.deepEqual(subject.calls, [])
})

test('stop() disarms the watcher before any later event can cancel', () => {
  const timers = fakeTimers()
  const subject = agent()
  const stop = createFirstAssistantCanceller({
    agent: subject,
    firstSeq: 10,
    enabled: true,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  })
  stop.stop()
  assert.equal(timers.timers.size, 0)
  subject.session.events.push({ type: 'assistant/message', seq: 10 })
  timers.fireAll()
  assert.deepEqual(subject.calls, [])
})
