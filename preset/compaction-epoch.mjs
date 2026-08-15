/**
 * Epoch-aware promotion tracker shared by the bootstrap plugins of the
 * anchored presets.
 *
 * A compaction rewrites the model-visible surface: the pre-compaction
 * conversation collapses into one synthetic summary message and the
 * workspace-instruction baseline is re-injected from scratch. The first
 * post-compaction request is therefore a "second first request" — the same
 * first-token conditions the anchored presets exist to control. Promotion is
 * epoch-aware: only a durable promotion signal (`tool/call` and/or
 * `assistant/message`, per the caller's `promoteEvents`) recorded AFTER the
 * last `compaction/end` boundary counts as promoted. Before any compaction
 * the boundary is -1, which preserves the original one-shot semantics.
 *
 * Fork isolation (local addition): a forked session replays its parent's
 * durable events below `header.seedLength`. Those inherited events must not
 * promote (or re-promote) the child, so the scan and the incremental feed both
 * ignore every event whose seq is below that boundary. State is memoized per
 * session OBJECT (WeakMap), never by session id, so tests and forks cannot
 * collide through string keys.
 */

/**
 * Events this session produced itself. `header.seedLength` is the durable
 * fork-lineage boundary: forked sessions replay parent history below that seq,
 * so only events at or after it count toward THIS session's anchor.
 */
function ownedEvents(session) {
  const events = session?.events
  if (events === undefined) return []
  const seedLength = Number(session.header?.seedLength ?? 0)
  if (seedLength <= 0) return events
  return events.filter(event => event.seq === undefined || event.seq >= seedLength)
}

/** Build one epoch-aware promotion tracker. */
export function createEpochPromotion(promoteEvents) {
  const promote = new Set(promoteEvents)
  /** session object -> { boundary, promoted } */
  const state = new WeakMap()

  /** Scan a session's OWN durable log from scratch (cold start / resume / fork). */
  const scan = (session) => {
    let boundary = -1
    let promoted = false
    for (const event of ownedEvents(session)) {
      const seq = event.seq ?? 0 // events without a seq are treated as post-boundary
      if (event.type === 'compaction/end') {
        boundary = seq
        promoted = false
        continue
      }
      if (promote.has(event.type) && seq > boundary) promoted = true
    }
    const entry = { boundary, promoted }
    state.set(session, entry)
    return entry
  }

  return {
    /**
     * Current phase of the agent's session.
     * @param agent - the assembly/pre-step agent, or undefined outside an agent.
     * @returns { boundary, promoted } — `boundary` is the last OWN compaction/end
     *   seq (-1 before any compaction); `promoted` is true when a durable
     *   promotion signal exists after that boundary.
     */
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true }
      const session = agent.session
      if (session === undefined) return { boundary: -1, promoted: true }
      // Subagents keep the full catalog from their very first request.
      if ((session.header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
      return state.get(session) ?? scan(session)
    },

    /** Incremental feed: call on every `session/event`. */
    observe(session, event) {
      const entry = state.get(session)
      if (entry === undefined) return // status() cold-scans the complete log
      const seedLength = Number(session.header?.seedLength ?? 0)
      if (seedLength > 0 && event.seq !== undefined && event.seq < seedLength) return
      const seq = event.seq ?? 0
      if (event.type === 'compaction/end') {
        state.set(session, { boundary: seq, promoted: false })
        return
      }
      if (promote.has(event.type) && seq > entry.boundary && !entry.promoted) {
        state.set(session, { ...entry, promoted: true })
      }
    },
  }
}
