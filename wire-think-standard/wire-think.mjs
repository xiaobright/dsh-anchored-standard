/**
 * Wire think-execute phase engine — every user turn opens with ONE think step
 * with tool definitions PRESENT in the request but invocation forbidden on
 * the wire (`tool_choice: "none"`), then a steering notice opens the execute
 * phase on the official provider with the resident catalog.
 *
 * Keeping the definitions visible while the wire forbids invocation lets the
 * model plan against everything it will actually be allowed to use, and
 * leaves tools one parameter away from working again. `tool_choice` is
 * outside the harness GenerateOptions vocabulary, so reaching this condition
 * takes the sanctioned wire seam:
 *
 *  1. THINK (step 0): the assembled request keeps its natural tool catalog
 *     (no stripping!), and an `agent/request` listener swaps ONLY the
 *     provider route to the sibling adapter (toolchoice-adapter.mjs, default
 *     `deepseek-wire-think`) — which puts `tool_choice: "none"` on the wire.
 *     The frozen loop-built request is untouched (the log-reconstructability
 *     invariant holds); only the route differs. Auto-injected context is
 *     still stripped during think steps (lever 3).
 *
 *     SCOPE NOTE (2026-08-17): like think-phase.mjs, this context strip is
 *     THINK-STEP-scoped, not session-phase-scoped — the shared context-gate's
 *     promotion phase machine does not map onto it, so the enumerated
 *     `suppressedContextSources` list stays here deliberately. Session-phase
 *     injection control (preset/, zero-anchored, whoami) belongs to
 *     context-gate; per-step strips are a documented exception.
 *  2. STEER: `agent/turn-stopping` steers exactly once per turn (same
 *     resume-safe machinery as think-phase.mjs).
 *  3. EXECUTE (step 1+): every other request runs on the ORIGINAL provider
 *     (the engine restores it, because the folded session header seeds the
 *     next step's config from the last request — which was the think route)
 *     and sees the promoted RESIDENT set (shells + str_replace_editor +
 *     discovery tools + dev_tool_search-unlocked names).
 *
 * Degradation ladder (never bricks a session):
 *  - sibling adapter not registered (row missing / DUPLICATE_ADAPTER on a
 *    second preset mount) → think steps fall back to the zero-tool
 *    condition, exactly like think-phase.mjs;
 *  - a filter failure → full catalog with a one-time warning;
 *  - a steer failure → the think reply stands as the turn's answer.
 *
 * Cost note: alternating provider routes per step forfeits DeepSeek prefix-
 * cache reuse on every switch, and each swap appends a request/header
 * change event. `mode: 'first-turn'` limits both to the session's first
 * user turn.
 *
 * Robustness: subagents default to always-execute (their briefs are already
 * plans); the steered-turn set rebuilds from durable steering/message
 * events on cold start; the original provider is captured from the first
 * non-swapped seed config and falls back to `defaultProvider`.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wire-think'

/**
 * Deliberately NO inject list: services are touched at event time only
 * (`ctx.get('llm')` inside the request listener), keeping the pre-step and
 * assemble registrations immediate — the OUTERMOST-transform discipline the
 * anchored presets rely on.
 */
export const inject = []

/** Same automatic injections the anchored variants strip while controlled. */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** Shell candidates (custom-bash registers `bash`; pwsh is Windows standard). */
const SHELLS = ['bash', 'pwsh']

/** Discovery tools always resident in the execute phase (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/** The official route this engine restores execute steps onto. */
const DEFAULT_OFFICIAL_PROVIDER = 'deepseek-official'

/** Default steering notice that opens the execute phase. */
export const STEER_TEXT = [
  'The thinking round is complete and all tools are now active.',
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

/** Register the per-session wire think/execute phase controller. */
export function apply(ctx, config) {
  const mode = parseMode(config?.mode)
  const thinkProvider = typeof config?.provider === 'string' && config.provider.length > 0
    ? config.provider
    : 'deepseek-wire-think'
  const defaultProvider = typeof config?.defaultProvider === 'string' && config.defaultProvider.length > 0
    ? config.defaultProvider
    : DEFAULT_OFFICIAL_PROVIDER
  const suppressedSources = sourceList(config?.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const includeSubagents = config?.includeSubagents === true
  const steerText = typeof config?.steerText === 'string' && config.steerText.length > 0 ? config.steerText : STEER_TEXT

  /** Per-session phase state + the captured original provider route. */
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
      entry = { phase: 'execute', turn: null, steered, originalProvider: undefined }
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

  /** Whether the sibling think route is registered (positive results cached). */
  let thinkRouteConfirmed = false
  const thinkRouteAvailable = () => {
    if (thinkRouteConfirmed) return true
    let available = false
    try {
      const providers = ctx.get('llm')?.listProviders?.() ?? []
      available = providers.some((entry) => (typeof entry === 'string' ? entry : entry?.id) === thinkProvider)
    } catch {
      available = false
    }
    if (available) {
      thinkRouteConfirmed = true
    } else {
      warnOnce(`${name}: think route "${thinkProvider}" is not registered — think steps degrade to the zero-tool condition`)
    }
    return available
  }

  /** Tool names the model explicitly unlocked via `dev_tool_search` (execute phase). */
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

  // Phase bookkeeping + think-phase context strip (outermost transform).
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

  // The wire lever: swap ONLY the provider route on think steps, and restore
  // the original route on every other step (the folded header seeds the next
  // step's config from the last request, which was the think route).
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      const entry = payload.agent === undefined ? undefined : state.get(payload.agent.session?.id)
      if (entry === undefined) return resolved
      if (typeof resolved?.provider !== 'string' || resolved.provider.length === 0) return resolved
      if (resolved.provider !== thinkProvider && entry.originalProvider === undefined) {
        entry.originalProvider = resolved.provider
      }
      if (entry.phase === 'think') {
        if (thinkRouteAvailable()) {
          return resolved.provider === thinkProvider ? resolved : { ...resolved, provider: thinkProvider }
        }
        return resolved
      }
      // EXECUTE: never let the think route leak into a tool-bearing step.
      if (resolved.provider === thinkProvider) {
        const restore = entry.originalProvider ?? defaultProvider
        return { ...resolved, provider: restore }
      }
      return resolved
    } catch (error) {
      warnOnce(`${name}: request routing failed, keeping the resolved config: ${String((error && error.message) || error)}`)
      return resolved
    }
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const entry = context.agent === undefined ? undefined : state.get(context.agent.session?.id)
      if (entry?.phase === 'think' && !thinkRouteAvailable()) {
        // Degraded think: the zero-tool condition (no wire lever).
        return { ...assembled, tools: [] }
      }
      if (entry?.phase !== 'think') {
        // EXECUTE (and unknown sessions): the promoted resident set.
        const available = new Set(assembled.tools.map((tool) => tool.name))
        const keep = new Set([
          ...SHELLS.filter((toolName) => available.has(toolName)),
          'str_replace_editor', ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(context.agent?.session),
        ])
        return {
          ...assembled,
          tools: assembled.tools.filter((tool) => keep.has(tool.name)),
        }
      }
      // THINK with the wire lever: keep the natural catalog untouched — the
      // sibling adapter forces `tool_choice: "none"` on the wire.
      return assembled
    } catch (error) {
      warnOnce(`${name}: phase filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // The think reply is text-only (tool_choice none), so the turn is about to
  // close — steer exactly once to open the execute phase.
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
          summary: 'activate the tool catalog for execution',
        },
      })
    } catch (error) {
      warnOnce(`${name}: steering failed, letting the turn close: ${String((error && error.message) || error)}`)
    }
  })
}
