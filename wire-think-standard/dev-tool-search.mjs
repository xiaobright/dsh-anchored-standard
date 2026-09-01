/**
 * dev-tool-search — on-demand tool discovery and unlock, the tool-search
 * pattern for the anchored preset.
 *
 * The promoted phase keeps only a minimal resident set (shell +
 * str_replace_editor + the discovery tools) instead of dumping the whole
 * Standard catalog at once. This plugin registers ONE small tool:
 *
 *  - `dev_tool_search` — search the FULL assembled catalog by keyword and
 *    return matching tool names with short descriptions; optionally unlock
 *    tools by exact name (array `toolNames`). Unlocked names are recorded as
 *    durable `tool/call` arguments, and tool-bootstrap.mjs's assemble filter
 *    exposes them from the next request on (resume-safe).
 *
 * The tool description is deliberately an INDEX of what the minimal resident
 * set cannot do: the model should reach for dev_tool_search the moment a task
 * needs internet, delegation, workflows, goals, images, background jobs, or
 * multi-agent coordination — not try to work around them with bash.
 *
 * FIX (local): search matching was AND-over-all-tokens, so a long natural
 * query ("file edit write replace script root permissions") matched NOTHING
 * even against the full catalog. Now: exact name match wins, then tools
 * matching at least one token ranked by hit count. The description also
 * teaches the unlock path explicitly ("search empty ≠ tool absent — unlock
 * by exact toolNames"), because models observed in the wild only search and
 * never pass toolNames.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dev-tool-search'

/** The tools registry must exist before this tool can register. */
export const inject = ['tools']

const MAX_RESULTS = 25

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * The capability index: resident minimal tools (bash / str_replace_editor /
 * skill_search / skill_load) cannot cover these, so the model must search
 * and unlock them on demand. Kept in the description so the model KNOWS what
 * exists without a full catalog dump.
 */
const UNLOCKABLE_INDEX = [
  'web_search — internet search and web retrieval',
  'subagent / subagent_fork / list_subagent_models — delegate work to sub-agents and choose their LLM',
  'workflow — run multi-agent workflow scripts',
  'ralph — fresh-agent iterative loop',
  'create_goal / get_goal / update_goal — long-running goals',
  'read_image — read image files',
  'job_list / job_output / job_kill — background jobs',
  'interrupt_agent / send_message / list_agents — multi-agent control',
  'todo_write — task tracking',
  'ask_user_question — ask the user',
]

/** Register the model-facing `dev_tool_search` tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dev_tool_search',
    description: [
      'Discover and unlock tools that are NOT currently available.',
      '',
      'This session starts with a minimal resident set: bash, str_replace_editor, skill_search, skill_load. Everything else is unlocked on demand through this tool.',
      '',
      'If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with bash:',
      ...UNLOCKABLE_INDEX.map((line) => `- ${line}`),
      '',
      'Usage: pass `query` to search the catalog (returns matching tool names + descriptions), then pass `toolNames` with exact names to unlock them. Unlocked tools appear from the next request on and stay unlocked for the session.',
      '',
      'Example: dev_tool_search({"query":"web","toolNames":["web_search"]}) — search AND unlock in one call.',
      'IMPORTANT: an empty search result does NOT mean the tool does not exist — it only means no tool matched ALL of your keywords. If the task needs any tool listed above, unlock it directly by exact name: dev_tool_search({"toolNames":["web_search"]}). Prefer short 1-2 keyword queries.',
    ].join('\n'),
    parameters: toJsonSchema({
      query: { type: 'string', required: false, description: 'search keywords (e.g. "web", "subagent")' },
      toolNames: { type: 'array', required: false, description: 'exact tool names to unlock', items: { type: 'string' } },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const unlock = Array.isArray(args.toolNames) ? args.toolNames.filter((name) => typeof name === 'string' && name.length > 0) : []

      const lines = []
      if (unlock.length > 0) {
        lines.push(`Unlocked for the next request: ${unlock.join(', ')}`)
      }
      if (query.length === 0 && unlock.length === 0) {
        lines.push('Provide `query` to search the catalog, or `toolNames` to unlock tools.')
        return { text: lines.join('\n') }
      }
      if (query.length === 0) {
        return { text: lines.join('\n') || 'Nothing to do.' }
      }

      try {
        // The executing agent IS the viewing scope: preset tools register into
        // the agent-scope layer of the tools registry, and schemas() with no
        // scope only sees the global layer — every preset-provided tool would
        // be invisible to keyword search (issue #24). Same pattern as the
        // harness's own code mode (`registry.schemas(exec.agent)`).
        const schemas = ctx.tools.schemas(exec?.agent)
        const wanted = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
        // FIX: score instead of AND-filter. Exact name match ranks first;
        // otherwise every tool matching at least one token competes, ordered
        // by hit count (desc) then name. A long natural-language query no
        // longer returns an empty catalog.
        const scored = schemas
          .map((schema) => {
            const haystack = `${schema.name} ${schema.description ?? ''}`.toLowerCase()
            let score = 0
            for (const token of wanted) if (haystack.includes(token)) score += 1
            return {
              schema,
              score,
              exact: wanted.includes(schema.name.toLowerCase()),
            }
          })
          .filter((entry) => wanted.length > 0 && (entry.exact || entry.score >= 1))
          .sort((a, b) => (b.exact - a.exact) || (b.score - a.score) || a.schema.name.localeCompare(b.schema.name))
        const matches = scored.slice(0, MAX_RESULTS)
        if (matches.length === 0) {
          lines.push(
            `No tools match "${query}". An empty result only means no tool matched ALL keywords — if you need a specific tool, unlock it directly by exact name, e.g. dev_tool_search({"toolNames":["web_search"]}).`,
          )
        } else {
          lines.push(`Matching tools (${matches.length}${scored.length > MAX_RESULTS ? ` of ${scored.length}` : ''}):`)
          for (const { schema, exact, score } of matches) {
            const desc = (schema.description || '').split('\n')[0].slice(0, 90)
            lines.push(`- ${schema.name}${exact ? ' (exact)' : ''}: ${desc}`)
          }
          if (scored.length > MAX_RESULTS) {
            lines.push(`(truncated at ${MAX_RESULTS} — add tokens to narrow the query, e.g. "mcp browser" or "mcp tavily")`)
          }
          lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).')
        }
      } catch (error) {
        lines.push(`catalog search unavailable: ${String((error && error.message) || error)}`)
      }
      return { text: lines.join('\n') }
    },
  })
}
