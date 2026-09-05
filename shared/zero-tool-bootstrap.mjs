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
 * epoch-aware (see compaction-epoch.mjs): after `compaction/end` the
 * session falls back to a controlled phase — the shells plus `compactionTools`
 * (a core work set, default none) — until a NEW durable assistant message
 * exists past that boundary. The zero-tool anchor applies ONLY to the very
 * first request: after a compaction the model is mid-task and needs to keep
 * working, but still faces a small catalog instead of the full Standard set.
 *
 * Injected reminders are NOT stripped here. Unified injection control lives
 * in the `context-gate` row, which both mode compositions mount FIRST (see
 * their agent.cordis.yml): while unpromoted it closes both unified injection
 * paths (the whole `SystemPrompt.context()` family plus a default-deny
 * pre-step gate), replacing this plugin's former enumerated
 * `suppressedContextSources` strip. The gate is strictly stronger: the enum
 * only filtered pre-step messages by `source.kind` and could not reach the
 * assembly's runtime-context contributions at all.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process; the
 *    durable event scan runs once per session per process, then O(1).
 *  - By default subagents are treated as already promoted so their first
 *    request can use tools. Set `includeSubagents: true` to make subagents
 *    follow the same zero-tool anchor phase as top-level sessions.
 *  - A filter failure degrades to the full catalog with a one-time warning,
 *    so a bug can never brick every request of a session.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'zero-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time.
 */
export const inject = []

/** Shell candidates (the anchored preset's custom-bash registers `bash`; pwsh is Windows standard). */
const SHELLS = ['bash', 'pwsh']

/** Discovery tools always resident after promotion (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/** Config keys this plugin accepts; anything else fails at mount (the removed `suppressedContextSources` included — migrate to the context-gate row). */
const ALLOWED_KEYS = new Set(['compactionTools', 'includeSubagents'])

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}; `
      + 'context suppression moved to the context-gate row',
    )
  }
  // Core work set exposed after a compaction, before re-promotion.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')

  const promotion = createEpochPromotion(['assistant/message'], { includeSubagents: source.includeSubagents === true })
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
}
