/**
 * Zero-tool bootstrap — keep the FIRST top-level model request on an EMPTY
 * tool surface, free of auto-injected workspace/skill context, then narrow
 * the catalog to a minimal RESIDENT set once the anchor turn has produced its
 * first durable assistant message.
 *
 * This is the extra test mode behind `zero-anchored-standard`: the anchor
 * plugin seeds a fixed user message and this filter strips the whole catalog,
 * so the first real request follows the zero-injection "we" trajectory. After
 * that assistant response is durable, later requests see the resident
 * catalog.
 *
 * WHY RESIDENT (local addition, user-measured): the promoted phase does NOT
 * dump the whole Standard catalog at once — that dump pulls the trajectory
 * back to standard-like behavior (measured post-promotion regression: a flood
 * of `let me` first-lines). Instead the catalog narrows to the shells +
 * `str_replace_editor` + the three discovery tools (`dev_tool_search`,
 * `skill_search`, `skill_load`) plus whatever the model explicitly unlocked
 * via `dev_tool_search`. Heavier Standard tools (web_search, subagent,
 * workflow, …) are one `dev_tool_search` call away; unlocked names are
 * derived from durable `tool/call` events, so resume and reload keep them.
 *
 * COMPACTION (local addition): a compaction rewrites the whole surface, so the
 * first post-compaction request is a "second first request". Promotion is
 * epoch-aware (see preset/compaction-epoch.mjs): after `compaction/end` the
 * session falls back to a controlled phase — the shells plus `compactionTools`
 * (a core work set, default none) — until a NEW durable assistant message
 * exists past that boundary. The zero-tool anchor applies ONLY to the very
 * first request: after a compaction the model is mid-task and needs to keep
 * working, but still faces a small catalog instead of the full Standard set.
 *
 * Injected reminders (the AGENTS.md digest and the `<available_skills>`
 * catalog, source kinds `agent-instructions` / `skill-catalog`) are stripped
 * during the controlled phase — same reasoning as the anchored variant
 * (issue #6: with the skill catalog present the anchor did not reproduce at
 * all, 0/9). `suppressedContextSources` is configurable; an empty array
 * disables the context filter while keeping the tool bootstrap.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process; the
 *    durable event scan runs once per session per process, then O(1).
 *  - Subagents and non-top-level agents always see the full catalog: their
 *    first request must be able to call tools.
 *  - A filter failure degrades to the full catalog with a one-time warning,
 *    so a bug can never brick every request of a session.
 */

import { createEpochPromotion } from '../preset/compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'zero-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time, and the pre-step strip below registers with `prepend: true` so it
 * stays the OUTERMOST waterfall transform (see the anchored copy for the full
 * registration-order reasoning).
 */
export const inject = []

/** Same automatic injections the anchored variant strips by default. */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** Shell candidates (the anchored preset's custom-bash registers `bash`; pwsh is Windows standard). */
const SHELLS = ['bash', 'pwsh']

/** Discovery tools always resident after promotion (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  // Core work set exposed after a compaction, before re-promotion.
  const compactionTools = stringListOrEmpty(config?.compactionTools, 'compactionTools')
  const suppressedSources = sourceList(config?.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)

  const promotion = createEpochPromotion(['assistant/message'])
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

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
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. The event's `arguments` is the raw JSON string the model produced;
   * we parse it defensively and read the `toolNames` array.
   */
/**
 * Events this session produced itself. `header.seedLength` is the durable
 * fork-lineage boundary: forked sessions replay parent history below that seq,
 * so only events at or after it count toward THIS session's anchors/unlocks.
 */
function ownedEvents(session) {
  const events = session?.events
  if (events === undefined) return []
  const seedLength = Number(session.header?.seedLength ?? 0)
  if (seedLength <= 0) return events
  return events.filter(event => event.seq === undefined || event.seq >= seedLength)
}

  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray(session.events)) return unlocked
    for (const event of ownedEvents(session)) {
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
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
    }
    return unlocked
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        // PROMOTED: keep the minimal resident set — the shells +
        // str_replace_editor + the discovery tools + whatever the model
        // explicitly unlocked via dev_tool_search — instead of dumping the
        // whole Standard catalog at once (the post-promotion regression fix).
        const available = new Set(assembled.tools.map((tool) => tool.name))
        const keep = new Set([
          ...SHELLS.filter((name) => available.has(name)),
          'str_replace_editor', ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(context.agent?.session),
        ])
        return {
          ...assembled,
          tools: assembled.tools.filter((tool) => keep.has(tool.name)),
        }
      }
      const { boundary } = status
      // First request (no compaction yet): zero tools, the "we" anchor.
      if (boundary < 0) return { ...assembled, tools: [] }
      // Post-compaction: core work set so mid-task work can continue.
      if (compactionTools.length === 0) return { ...assembled, tools: [] }
      const available = new Set(assembled.tools.map((tool) => tool.name))
      const selectedShells = SHELLS.filter((toolName) => available.has(toolName))
      const missing = compactionTools.filter((toolName) => !available.has(toolName))
      if (selectedShells.length === 0 || missing.length > 0) {
        warnOnce(
          `${name}: expected at least one phase shell and every phase tool; `
          + `shells=${JSON.stringify(selectedShells)}, missing=${JSON.stringify(missing)} — `
          + 'bootstrap disabled, full catalog exposed',
        )
        return assembled
      }
      const keep = new Set([...selectedShells, ...compactionTools])
      return {
        ...assembled,
        tools: assembled.tools.filter((tool) => keep.has(tool.name)),
      }
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Strip injected reminders (skill catalog, AGENTS.md) during the controlled
  // phase. Same registration discipline as the anchored variant: `prepend`
  // keeps the strip the OUTERMOST transform of the agent/pre-step waterfall.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (promotion.status(agent).promoted || suppressedSources.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
