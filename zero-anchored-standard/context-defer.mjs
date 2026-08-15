/**
 * context-defer — the `deferSources` mechanism for the zero-anchored preset.
 *
 * Unlike the anchored preset's tool-bootstrap, this plugin does NOT touch the
 * tool catalog and does NOT cap output or strip the skill/instruction
 * injections: the zero-tool bootstrap owns the zero-tool anchor turn, and this
 * row only re-queues configured plugin recall messages (local memory /
 * document knowledge) until the same `assistant/message` promotion the zero
 * anchor uses.
 *
 * Promotion follows the same epoch-aware tracker as the zero-tool
 * bootstrap: a `compaction/end` boundary resets promotion so deferred recalls
 * are held back again until a NEW durable promotion signal appears past it.
 */

import { createEpochPromotion } from '../preset/compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'context-defer'

/** Deliberately NO inject list; register this row FIRST in the composition. */
export const inject = []

const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

function sourceMatcherList(value, field) {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return []
  if (!Array.isArray(value)) {
    throw new TypeError(`${name}: ${field} must be an array of source matchers`)
  }
  return value.map((item, index) => {
    const at = `${field}[${index}]`
    if (typeof item === 'string') {
      if (item.length === 0) throw new TypeError(`${name}: ${at} kind must be a non-empty string`)
      return { kind: item }
    }
    if (item === null || typeof item !== 'object') {
      throw new TypeError(`${name}: ${at} must be a source kind string or a { kind, plugin?, form? } object`)
    }
    if (typeof item.kind !== 'string' || item.kind.length === 0) {
      throw new TypeError(`${name}: ${at}.kind must be a non-empty string`)
    }
    const matcher = { kind: item.kind }
    for (const key of ['plugin', 'form']) {
      if (item[key] === undefined) continue
      if (typeof item[key] !== 'string' || item[key].length === 0) {
        throw new TypeError(`${name}: ${at}.${key} must be a non-empty string`)
      }
      matcher[key] = item[key]
    }
    return matcher
  })
}

function matchesDeferredSource(message, matchers) {
  const source = message?.source
  if (source === undefined) return false
  return matchers.some(matcher =>
    source.kind === matcher.kind
    && (matcher.plugin === undefined || source.plugin === matcher.plugin)
    && (matcher.form === undefined || source.form === matcher.form),
  )
}

export function apply(ctx, config) {
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const deferredSources = sourceMatcherList(config.deferSources, 'deferSources')

  const promotion = createEpochPromotion(promoteEvents)
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  const isPromoted = (agent) => promotion.status(agent).promoted

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (isPromoted(agent) || deferredSources.length === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const original = decision.messages
      const deferred = original.filter(message => matchesDeferredSource(message, deferredSources))
      if (deferred.length === 0) return decision
      const kept = original.filter(message => !deferred.includes(message))
      if (kept.length === 0) {
        return decision
      }
      for (const message of deferred.toReversed()) {
        agent.inbox.prepend('next-step', message)
      }
      return { ...decision, messages: kept }
    } catch (error) {
      warnOnce(`${name}: pre-step deferral failed, keeping messages: ${String(error?.message ?? error)}`)
      return decision
    }
  }, { prepend: true })
}
