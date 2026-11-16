/**
 * cot-drip — deliberation maintenance for the EXECUTE phase.
 *
 * The anchor modes (and the think/execute split) open each turn with deep
 * reasoning, but deliberation decays across a long tool loop: once the model
 * is mid-execution, later steps collapse back to thin "Let me…" actions. This plugin drips ONE short user-role
 * reminder into the conversation after every Nth tool result — never
 * blocking, never erroring, never touching the tool catalog:
 *
 *   `tools/post-execute` → { kind: 'accept', additionalContexts: [notice] }
 *
 * The harness appends `additionalContexts` as durable user messages AFTER
 * all tool results of the batch, so the reminder lands in the NEXT request
 * exactly where a planning beat belongs — the same delivery shape Code Mode
 * uses for nested sub-call contexts. The model reads it, restates the goal
 * in one "We …" sentence, and continues; the user sees ordinary tool calls
 * plus a one-line context chip.
 *
 * Cadence is deliberately gentle: default `every: 4` results, at most
 * `maxPerTurn: 1` reminder per turn. `every: 0` disables the drip.
 *
 * Robustness: subagents default to undripped; counters reset per turn
 * (turn boundaries tracked from durable events, with a session-global
 * fallback if turn numbers are unavailable); any failure keeps the decision
 * from `next()` untouched.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cot-drip'

/**
 * Deliberately NO inject list: the listener only touches services at event
 * time and nothing needs to exist before `apply`.
 */
export const inject = []

/** Default reminder text — one planning beat, phrased to sustain the "We" voice. */
export const DRIP_TEXT = [
  'Progress check: before the next action, restate in one "We …" sentence what remains of the goal and why the next step is the right one.',
].join(' ')

function parseCounter(value, field, fallback, minimum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name}: ${field} must be an integer >= ${minimum}; got ${JSON.stringify(value)}`)
  }
  return value
}

/** Register the post-execution deliberation drip. */
export function apply(ctx, config) {
  const every = parseCounter(config?.every, 'every', 4, 0)
  const maxPerTurn = parseCounter(config?.maxPerTurn, 'maxPerTurn', 1, 1)
  const includeSubagents = config?.includeSubagents === true
  const text = typeof config?.text === 'string' && config.text.length > 0 ? config.text : DRIP_TEXT

  /** sessionId -> { results, drips, lastTurn } — per-turn counters. */
  const state = new Map()

  const countersOf = (sessionId) => {
    let entry = state.get(sessionId)
    if (entry === undefined) {
      entry = { results: 0, drips: 0, lastTurn: undefined }
      state.set(sessionId, entry)
    }
    return entry
  }

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  // Turn tracking: reset the counters on turn/start, remember the newest
  // turn from assistant/chunk when start events carry no usable number.
  ctx.on('session/event', (session, event) => {
    if (session === undefined || session.id === undefined) return
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      const entry = countersOf(session.id)
      if (entry.lastTurn !== turn) {
        entry.lastTurn = typeof turn === 'number' ? turn : entry.lastTurn
        entry.results = 0
        entry.drips = 0
      }
      return
    }
    if (event.type === 'assistant/chunk') {
      const turn = event.data?.turn
      if (typeof turn !== 'number') return
      const entry = countersOf(session.id)
      if (entry.lastTurn === undefined || turn > entry.lastTurn) {
        // A chunk of a newer turn without a seen turn/start: reset there.
        entry.lastTurn = turn
        entry.results = 0
        entry.drips = 0
      }
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Count synchronously before awaiting, so parallel calls cannot race
    // past the cadence.
    const session = exec?.agent?.session
    const eligible = session !== undefined
      && session.id !== undefined
      && (includeSubagents || (session.header?.delegationDepth ?? 0) === 0)
    const entry = eligible ? countersOf(session.id) : undefined
    if (entry !== undefined) entry.results += 1
    const due = entry !== undefined
      && every > 0
      && entry.results % every === 0
      && entry.drips < maxPerTurn
    // Reserve the cap in the same synchronous block: every parallel call
    // reaches here before any `await next()` resolves, so incrementing after
    // the await lets each caller see drips=0 and pass the cap at once.
    if (due) entry.drips += 1

    const decision = await next()
    try {
      if (decision?.kind !== 'accept') {
        if (due) entry.drips -= 1
        return decision
      }
      if (!due) return decision
      const notice = {
        id: `cot-drip-${crypto.randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'deliberation maintenance beat',
        },
      }
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), notice],
      }
    } catch (error) {
      if (due) entry.drips -= 1
      warnOnce(`${name}: drip injection failed, keeping the plain result: ${String((error && error.message) || error)}`)
      return decision
    }
  })
}
