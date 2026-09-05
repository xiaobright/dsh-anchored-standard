/**
 * Think-execute two-phase bootstrap — EVERY user turn opens with ONE
 * zero-tool THINK step, then continues with the promoted resident catalog
 * for execution.
 *
 * This is the engine behind the think/execute split: separate thinking from
 * execution. On DeepSeek V4 Pro the deepest "We …" reasoning chains happen
 * when the request carries NO tool definitions, while a callable catalog
 * collapses deliberation before the first tool call — so the think step
 * strips the whole catalog. (A tools-visible-but-locked variant needs
 * wire-level `tool_choice`, which the official deepseek adapter does not
 * map at all (MVP cut); the sibling repository's `wire-think-standard`
 * covers that variant.)
 *
 * Mechanism, per user turn:
 *
 *  1. THINK (step 0): `system-prompt/assemble` strips the catalog to ZERO
 *     tools and `agent/pre-step` strips auto-injected context (an enumerated
 *     `suppressedContextSources` list), so the first
 *     request of the turn reproduces the zero-tool condition on the REAL user
 *     message — no synthetic anchor round, no deferred input. The model
 *     writes its full "We …" plan as an ordinary assistant reply.
 *
 *     SCOPE NOTE (2026-08-17): this strip is THINK-STEP-scoped (one step per
 *     turn), not session-phase-scoped — the shared context-gate's promotion
 *     phase machine does not map onto it, so the enumerated list stays here
 *     deliberately. Session-phase injection control (preset/, zero-anchored,
 *     whoami) belongs to context-gate; per-step strips are a documented
 *     exception.
 *  2. STEER: a text-only reply would close the turn, so `agent/turn-stopping`
 *     (the serial pre-commit checkpoint) calls `agent.steer(...)` exactly
 *     once per turn with a plugin-sourced notice: "tools are now open —
 *     execute the plan, or restate the final answer".
 *  3. EXECUTE (step 1+): the phase flips to execute and every later request
 *     of the turn sees the minimal RESIDENT set — the shells +
 *     `str_replace_editor` + the discovery tools + whatever the model
 *     explicitly unlocked via `dev_tool_search` (same promoted phase as the
 *     zero-anchored preset, including resume-safe unlocked-name derivation).
 *
 * `mode: 'first-turn'` degrades to the classic single anchor (only the
 * session's first user turn thinks; later turns open with tools directly)
 * when the per-turn extra model call is not worth it.
 *
 * Robustness:
 *  - The steered-turn set is rebuilt from durable `steering/message` events
 *    (source.plugin === 'think-phase') on cold start, so a restart mid-turn
 *    never steers twice; an in-memory set guards the same process.
 *  - A crashed-before-steer turn resumes as an execute step (step index > 0)
 *    with the plan already durable in history — graceful degradation, never
 *    a stuck turn.
 *  - Subagents default to always-execute (their briefs are already plans);
 *    `includeSubagents: true` makes them think first too.
 *  - A filter failure degrades to the full catalog with a one-time warning,
 *    so a bug can never brick every request of a session.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'think-phase'

/**
 * Deliberately NO inject list, first row of the composition, `prepend: true`
 * registration — the same discipline as tool-bootstrap.mjs: the listener only
 * touches services at event time and stays the OUTERMOST waterfall transform,
 * so this filter's post-`next()` rewrite always gets the final say.
 */
export const inject = []

/** Same automatic injections the anchored variants strip while controlled. */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** Shell candidates (custom-bash registers `bash`; pwsh is Windows standard). */
const SHELLS = ['bash', 'pwsh']

/** Discovery tools always resident in the execute phase (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/** Default steering notice that opens the execute phase. */
export const STEER_TEXT = [
  'The thinking round is complete and all tools are now open.',
  'Proceed to execute the plan you laid out in your previous message, using the available tools.',
  'If that message already fully answers the user and no file, command, or verification work remains, restate the final answer concisely and finish.',
].join(' ')

function parseMode(value) {
  if (value === undefined || value === 'every-turn') return 'every-turn'
  if (value === 'first-turn') return 'first-turn'
  throw new TypeError(`${name}: mode must be "every-turn" or "first-turn"; got ${JSON.stringify(value)}`)
}

function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/** Register the per-session think/execute phase controller. */
export function apply(ctx, config) {
  const mode = parseMode(config?.mode)
  const suppressedSources = sourceList(config?.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const includeSubagents = config?.includeSubagents === true
  const steerText = typeof config?.steerText === 'string' && config.steerText.length > 0 ? config.steerText : STEER_TEXT

  /**
   * Per-session phase state: which phase the NEXT request of the session is
   * in, the turn that state was recorded for, and the turns already steered.
   * The steered set is rebuilt once from durable `steering/message` events
   * so a process restart never double-steers a turn.
   */
  const state = new Map()

  const ensure = (agent) => {
    const session = agent?.session
    if (session === undefined) return undefined
    let entry = state.get(session.id)
    if (entry === undefined) {
      const steered = new Set()
      if (Array.isArray((session.snapshotEvents ? session.snapshotEvents() : (session.events ?? [])))) {
        for (const event of (session.snapshotEvents ? session.snapshotEvents() : (session.events ?? []))) {
          if (event.type !== 'steering/message') continue
          if (event.data?.source?.plugin === name && typeof event.data?.turn === 'number') {
            steered.add(event.data.turn)
          }
        }
      }
      entry = { phase: 'execute', turn: null, steered }
      state.set(session.id, entry)
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

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session (execute phase). Derived from durable `tool/call` events so
   * resume/reload keeps them — same derivation as zero-tool-bootstrap.
   */
  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray((session.snapshotEvents ? session.snapshotEvents() : (session.events ?? [])))) return unlocked
    for (const event of (session.snapshotEvents ? session.snapshotEvents() : (session.events ?? []))) {
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const toolName of names) if (typeof toolName === 'string' && toolName.length > 0) unlocked.add(toolName)
    }
    return unlocked
  }

  // Phase bookkeeping + think-phase context strip. Registration discipline
  // copied from the anchored presets: `prepend` keeps this the OUTERMOST
  // transform of the agent/pre-step waterfall.
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const entry = ensure(agent)
    if (entry === undefined) return decision
    entry.turn = turn
    const subagent = (agent.session.header?.delegationDepth ?? 0) > 0
    const firstUserTurn = !Array.isArray((agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? []))) || !(agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).some((event) => event.type === 'user/message')
    const think = step === 0
      && (!subagent || includeSubagents)
      && (mode === 'every-turn' || firstUserTurn)
    entry.phase = think ? 'think' : 'execute'
    if (!think || suppressedSources.size === 0) return decision
    try {
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const entry = context.agent === undefined ? undefined : state.get(context.agent.session?.id)
      if (entry?.phase === 'think') {
        // THINK: the zero-tool condition on the real user message.
        return { ...assembled, tools: [] }
      }
      // EXECUTE (and unknown sessions — compaction service calls, cold
      // assemblies): the promoted resident set, exactly like zero-tool-
      // bootstrap's promoted phase.
      const available = new Set(assembled.tools.map((tool) => tool.name))
      const keep = new Set([
        ...SHELLS.filter((toolName) => available.has(toolName)),
        'str_replace_editor', ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(context.agent?.session),
      ])
      return {
        ...assembled,
        tools: assembled.tools.filter((tool) => keep.has(tool.name)),
      }
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: phase filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // The think reply is text-only (no tools existed to call), so the turn is
  // about to close — steer exactly once to open the execute phase.
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const session = agent?.session
    if (session === undefined) return
    const entry = state.get(session.id)
    if (entry === undefined || entry.phase !== 'think' || entry.turn !== turn) return
    if (entry.steered.has(turn)) return
    entry.steered.add(turn)
    try {
      agent.steer({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: steerText }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'open the tool catalog for execution',
        },
      })
    } catch (error) {
      // Steering must never break the turn boundary: degrade to letting the
      // think reply stand as the turn's answer.
      warnOnce(`${name}: steering failed, letting the turn close: ${String((error && error.message) || error)}`)
    }
  })
}
