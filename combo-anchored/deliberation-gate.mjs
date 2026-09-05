/**
 * Deliberation gate — the full Standard catalog stays visible and callable
 * (the session looks and feels completely normal), but the FIRST tool call
 * of a turn is denied with an anchor directive when the turn has not yet
 * shown enough reasoning.
 *
 * This is the engine behind `deliberation-gate` — a trajectory-depth gate
 * built on the observable layer (the harness adapters expose no logprobs):
 * durable `assistant/chunk` events carry every reasoning/text delta of the
 * live trajectory, and their accumulated length per turn is a cheap, robust
 * deliberation-depth proxy for the collapse a callable catalog causes —
 * pre-action reasoning shrinks to a fraction of its no-tools depth. When
 * the proxy says "shallow", the gate denies once with a planning directive
 * (a push-back while tools stay live — the intervention shape that both
 * prompts deeper reasoning and keeps tool calls working); the retry then
 * carries the forced deliberation in-history.
 *
 * Behavior:
 *  - `session/event` accumulates `text-delta`/`reasoning-delta` lengths per
 *    (session, turn) from `assistant/chunk` records (the durable log keeps
 *    every chunk; wire telemetry drops most of them). Tool-call deltas carry
 *    no `.text` but still open the turn's entry, so the counter is live by
 *    the time a call dispatches.
 *  - A resumed session (no in-process chunk state) is cold-scanned from its
 *    durable log on first dispatch, so restarts keep the same depth.
 *  - `tools/pre-execute` checks the CURRENT turn's accumulated depth before
 *    dispatch: at or above `minChars` (default 400, tunable) the call
 *    proceeds untouched; below it, the call is denied
 *    with `gateText` (a planning prompt, phrased so it never reads as a tool
 *    failure) at most `maxGatesPerTurn` times (default 1) — the retry then
 *    carries the forced deliberation in-history.
 *  - A turn with no streamed text at all reads as depth zero and gates
 *    exactly once — failing safe toward MORE deliberation, never silence.
 *
 * Robustness:
 *  - The gate decision is fully synchronous up to the deny (no `await`
 *    before the counters mutate), so parallel tool calls cannot race past
 *    the budget.
 *  - Subagents default to ungated (their briefs are already plans); set
 *    `includeSubagents: true` to gate them too.
 *  - Executions without an agent (service-owned calls) pass untouched.
 *  - Per-session turn maps are pruned to the last few turns, so long
 *    sessions do not accumulate state.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'deliberation-gate'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time and nothing needs to exist before `apply`.
 */
export const inject = []

/** Default deliberation floor before the first tool call of a turn (chars). */
export const DEFAULT_MIN_CHARS = 400

/** Default directive denied back to the model on a gated call. */
export const GATE_TEXT = [
  'Deliberation gate: this turn has not shown its reasoning yet.',
  'Before retrying this tool call, write out your full reasoning in your reply — start with "We", restate the goal, weigh the approaches, and lay out the concrete steps and risks — then issue the tool call again.',
  'This message is a planning prompt, not a tool failure.',
].join(' ')

/** Keep at most this many recent turns of depth state per session. */
const MAX_TRACKED_TURNS = 8

function parseCounter(value, field, fallback, minimum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name}: ${field} must be an integer >= ${minimum}; got ${JSON.stringify(value)}`)
  }
  return value
}

/** Register the trajectory-depth gate. */
export function apply(ctx, config) {
  const minChars = parseCounter(config?.minChars, 'minChars', DEFAULT_MIN_CHARS, 0)
  const maxGatesPerTurn = parseCounter(config?.maxGatesPerTurn, 'maxGatesPerTurn', 1, 1)
  const includeSubagents = config?.includeSubagents === true
  const gateText = typeof config?.gateText === 'string' && config.gateText.length > 0 ? config.gateText : GATE_TEXT

  /** sessionId -> { turns: Map<turn, { chars, gates }>, lastTurn } */
  const state = new Map()

  /** Live feed path: create/extend the turn entry on every streamed chunk. */
  const observeChunk = (sessionId, turn, textLength) => {
    let entry = state.get(sessionId)
    if (entry === undefined) {
      entry = { turns: new Map(), lastTurn: turn }
      state.set(sessionId, entry)
    }
    let turnEntry = entry.turns.get(turn)
    if (turnEntry === undefined) {
      // Prune old turns so long sessions do not accumulate state.
      if (entry.turns.size >= MAX_TRACKED_TURNS) {
        const oldest = [...entry.turns.keys()].sort((a, b) => a - b).slice(0, entry.turns.size - MAX_TRACKED_TURNS + 1)
        for (const key of oldest) entry.turns.delete(key)
      }
      turnEntry = { chars: 0, gates: 0 }
      entry.turns.set(turn, turnEntry)
    }
    turnEntry.chars += textLength
    if (turn > entry.lastTurn) entry.lastTurn = turn
  }

  /**
   * Depth state of a session, cold-scanning its durable log on first sight
   * so a resumed session keeps the depth it streamed before the restart.
   */
  const depthOf = (session) => {
    let entry = state.get(session.id)
    if (entry === undefined) {
      entry = { turns: new Map(), lastTurn: -1 }
      if (Array.isArray((session.snapshotEvents ? session.snapshotEvents() : (session.events ?? [])))) {
        for (const event of (session.snapshotEvents ? session.snapshotEvents() : (session.events ?? []))) {
          if (event.type !== 'assistant/chunk') continue
          const turn = event.data?.turn
          if (typeof turn !== 'number' || !Number.isFinite(turn)) continue
          const text = event.data?.chunk?.text
          observeChunk(session.id, turn, typeof text === 'string' ? text.length : 0)
        }
        entry = state.get(session.id) ?? entry
      }
      if (entry.turns.size === 0) {
        // No streamed text anywhere: depth reads as zero on a sentinel turn,
        // so the session still gets exactly one gated call, then passes.
        entry.turns.set(entry.lastTurn, { chars: 0, gates: 0 })
      }
      state.set(session.id, entry)
    }
    return entry
  }

  // Depth proxy: accumulate the turn's streamed reasoning/text lengths from
  // durable assistant/chunk records.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/chunk') return
    const turn = event.data?.turn
    if (typeof turn !== 'number' || !Number.isFinite(turn)) return
    const text = event.data?.chunk?.text
    observeChunk(session.id, turn, typeof text === 'string' ? text.length : 0)
  })

  // The gate: synchronous decision, deny at most maxGatesPerTurn per turn
  // while the accumulated depth of the CURRENT turn sits below minChars.
  ctx.on('tools/pre-execute', (exec, next) => {
    const session = exec?.agent?.session
    if (session === undefined || session.id === undefined) return next()
    if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return next()
    const entry = depthOf(session)
    const turnEntry = entry.turns.get(entry.lastTurn)
    if (turnEntry === undefined) return next()
    if (turnEntry.gates >= maxGatesPerTurn) return next()
    if (turnEntry.chars >= minChars) return next()
    turnEntry.gates += 1
    return { kind: 'deny', reason: gateText }
  })
}
