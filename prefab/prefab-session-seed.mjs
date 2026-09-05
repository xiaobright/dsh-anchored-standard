/**
 * prefab-session-seed — hydrate a newly selected prefab preset in place.
 *
 * DeepSeek Harness creates a blank session before it mounts the preset chosen
 * in the UI. The committed `agent-preset/selected` event is therefore the
 * first point where a preset-local plugin can identify the real destination
 * session. We schedule one microtask (Session.append cannot re-enter its own
 * publication boundary), then replay the model-visible prefab transcript into
 * that same session before the preset-selection RPC returns to the client.
 *
 * The template contains thousands of token-stream `assistant/chunk` events.
 * They are trace/UI data, not model history. Replaying only lifecycle events,
 * surface messages, tool calls and tool results preserves the exact derived
 * conversation and durable tool unlocks while avoiding a websocket event
 * flood when a user creates a session.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'prefab-session-seed'
export const inject = ['agents', 'skills']

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TEMPLATE = join(HERE, 'template.jsonl')
const DIRECTORY_PRESET = basename(HERE)
const DEFAULT_PRESET = DIRECTORY_PRESET === 'prefab' ? 'prefab-anchored-standard' : DIRECTORY_PRESET
export const readyTitleForPreset = (presetId) => presetId.includes('project2')
  ? 'Prefab Anchored Project2 - Ready'
  : 'Prefab Anchored Standard - Ready'
const READY_TITLE = readyTitleForPreset(DEFAULT_PRESET)
export const DEFAULT_DURABLE_TOOLS = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'ask_user_question',
  'todo_write',
  'web_search',
])

const RETAINED_TYPES = new Set([
  'turn/start',
  'step/start',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'step/end',
  'turn/end',
])

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Recursively replace every textual occurrence of the roll-time cwd. */
function rewriteCwd(value, sourceCwd, targetCwd) {
  const sourceUsesWindowsPaths = /^[A-Za-z]:[\\/]/.test(sourceCwd)
  const sourceBackslashes = sourceCwd.replace(/\//g, '\\')
  const targetBackslashes = targetCwd.replace(/\//g, '\\')
  const forms = [
    [sourceCwd.replace(/\\/g, '/'), targetCwd.replace(/\\/g, '/')],
    [sourceBackslashes.replace(/\\/g, '\\\\'), targetBackslashes.replace(/\\/g, '\\\\')],
    [sourceBackslashes, targetBackslashes],
  ].filter(([source], index, all) => all.findIndex(([candidate]) => candidate === source) === index)

  const visit = (item) => {
    if (typeof item === 'string') {
      let rewritten = item
      for (const [source, target] of forms) {
        rewritten = rewritten.replace(
          new RegExp(escapeRegExp(source), sourceUsesWindowsPaths ? 'gi' : 'g'),
          () => target,
        )
      }
      return rewritten
    }
    if (Array.isArray(item)) return item.map(visit)
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]))
    }
    return item
  }

  return visit(value)
}

function toolCallReadsInstructionFile(event) {
  const name = event.data?.name
  if (name !== 'bash' && name !== 'str_replace_editor' && name !== 'read') return false
  const raw = event.data?.arguments
  let text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  try {
    text = JSON.stringify(JSON.parse(text))
  } catch {
    // Older templates may contain an unparsed shell command.
  }
  return /(?:^|[\\/])(?:AGENTS|CLAUDE)(?:\.local)?\.md\b/i.test(text)
}

function textParts(event) {
  const block = event.data?.message?.content?.[0]
  return Array.isArray(block?.content) ? block.content : []
}

function toolResultCallId(event) {
  return event.data?.message?.source?.callId
    ?? event.data?.message?.content?.find((block) => block?.type === 'tool-result')?.toolCallId
}

function failedInstructionReadIds(rows) {
  const calls = new Map(rows
    .filter((event) => event.type === 'tool/call')
    .map((event) => [event.data?.callId, event]))
  const failed = new Set()
  for (const event of rows) {
    if (event.type !== 'tool/result') continue
    const callId = toolResultCallId(event)
    const call = calls.get(callId)
    if (call === undefined || !toolCallReadsInstructionFile(call)) continue
    const block = event.data?.message?.content?.find((item) => item?.type === 'tool-result')
    const hasError = block?.isError === true || (Array.isArray(block?.content)
      && block.content.some((part) => typeof part?.text === 'string' && /^\s*Error:/i.test(part.text)))
    if (hasError) failed.add(callId)
  }
  return failed
}

function cleanAssistantMessage(event, failedCallIds) {
  if (event.type !== 'assistant/message' || failedCallIds.size === 0) return event
  let removed = false
  const content = event.data?.message?.content?.flatMap((block) => {
    if (block?.type === 'tool-call' && failedCallIds.has(block.id)) {
      removed = true
      return []
    }
    if (block?.type !== 'reasoning') return [block]
    let text = block.text
    if (text.startsWith('Tool errors:')) {
      text = 'We should survey the available skills with narrower queries, then read AGENTS.md in full in the next step.'
    } else if (text.startsWith('We need read AGENTS full.')) {
      text = 'Now read AGENTS.md in full with the editor\'s explicit full-file range.'
    } else if (text.includes('Could also cat via bash but native tools preferred')) {
      text = text.replace(/Also read AGENTS\.md\.[\s\S]*$/, 'Then read AGENTS.md in full with the editor\'s explicit full-file range.')
    }
    return [{ ...block, text }]
  })
  if (!removed && content.every((block, index) => block === event.data.message.content[index])) return event
  return {
    ...event,
    data: {
      ...event.data,
      message: { ...event.data.message, content },
    },
  }
}

function rewriteDurableUnlocks(event, durableTools) {
  let changed = false
  const rewriteArgs = (raw) => {
    let parsed
    try { parsed = JSON.parse(raw) } catch { return raw }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    parsed.query = 'filesystem, search, task tracking, and user interaction tools'
    parsed.toolNames = [...durableTools]
    changed = true
    return JSON.stringify(parsed)
  }
  const rewriteText = (text) => {
    let next = text.replace(
      /^Unlocked for the next request: [^\r\n]*/m,
      `Unlocked for the next request: ${durableTools.join(', ')}`,
    )
    next = next.replace(
      /I unlocked `web_search` and `todo_write` via `dev_tool_search`/,
      `I unlocked ${durableTools.map((tool) => `\`${tool}\``).join(', ')} via \`dev_tool_search\``,
    )
    if (next !== text) changed = true
    return next
  }

  if (event.type === 'tool/call' && event.data?.name === 'dev_tool_search') {
    const argumentsText = rewriteArgs(event.data.arguments)
    return changed ? { ...event, data: { ...event.data, arguments: argumentsText } } : event
  }
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content?.map((block) => {
      if (block?.type === 'tool-call' && block.name === 'dev_tool_search') {
        const argumentsText = rewriteArgs(block.arguments)
        return argumentsText === block.arguments ? block : { ...block, arguments: argumentsText }
      }
      if ((block?.type === 'reasoning' || block?.type === 'text') && typeof block.text === 'string') {
        const text = rewriteText(block.text)
        return text === block.text ? block : { ...block, text }
      }
      return block
    })
    return changed
      ? { ...event, data: { ...event.data, message: { ...event.data.message, content } } }
      : event
  }
  if (event.type === 'tool/result') {
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) return event
    const content = blocks.map((block) => {
      if (!Array.isArray(block?.content)) return block
      const parts = block.content.map((part) => typeof part?.text === 'string'
        ? { ...part, text: rewriteText(part.text) }
        : part)
      return { ...block, content: parts }
    })
    return changed
      ? { ...event, data: { ...event.data, message: { ...event.data.message, content } } }
      : event
  }
  return event
}

/** Parse and validate the immutable, bundled roll template once at mount. */
export function loadPrefabTemplate(path = DEFAULT_TEMPLATE) {
  const rows = readFileSync(path, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
  const header = rows[0]
  if (header?.type !== 'session' || typeof header.cwd !== 'string' || header.cwd.length === 0) {
    throw new Error(`${name}: template must start with a session header containing cwd`)
  }

  const failedCallIds = failedInstructionReadIds(rows)
  const retained = []
  let instructionResultSeq
  let pendingInstructionRead = false
  for (const event of rows.slice(1)) {
    // Packed rows contain only assistant/chunk events, which are intentionally
    // absent from the compact replay.
    if (!RETAINED_TYPES.has(event.type)) continue
    if (event.type === 'tool/call' && failedCallIds.has(event.data?.callId)) continue
    if (event.type === 'tool/result' && failedCallIds.has(toolResultCallId(event))) continue
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.data === undefined) {
      throw new Error(`${name}: retained template event has an invalid envelope`)
    }
    if (SURFACE_TYPES.has(event.type) && event.surfaceOp !== 'append') {
      throw new Error(`${name}: compact replay only supports append-only prefab surfaces`)
    }
    const cleaned = cleanAssistantMessage(event, failedCallIds)
    retained.push(cleaned)
    if (cleaned.type === 'tool/call') pendingInstructionRead = toolCallReadsInstructionFile(cleaned)
    if (cleaned.type === 'tool/result') {
      if (pendingInstructionRead && instructionResultSeq === undefined) {
        const hasSuccessfulText = textParts(event).some((part) =>
          typeof part.text === 'string'
          && part.text.trim().length > 0
          && !/^\s*(?:error|toolerror)\s*:/i.test(part.text))
        if (hasSuccessfulText) instructionResultSeq = event.seq
      }
      pendingInstructionRead = false
    }
  }

  if (!retained.some((event) => event.type === 'turn/start')
    || !retained.some((event) => event.type === 'turn/end')) {
    throw new Error(`${name}: template has no complete prefab turn`)
  }
  return Object.freeze({
    sourceCwd: header.cwd,
    retained: Object.freeze(retained),
    instructionResultSeq,
  })
}

function replaceInstructionResult(event, agentsMd) {
  const block = event.data?.message?.content?.[0]
  if (!Array.isArray(block?.content)) return event
  let replaced = false
  const content = block.content.map((part) => {
    if (replaced || typeof part.text !== 'string' || /^\s*(?:error|toolerror)\s*:/i.test(part.text)) return part
    replaced = true
    return { ...part, text: agentsMd }
  })
  if (!replaced) return event
  return {
    ...event,
    data: {
      ...event.data,
      message: {
        ...event.data.message,
        content: [{ ...block, content }],
      },
    },
  }
}

/** Load exact global then workspace instructions without scanning the project. */
export function loadInstructionBundle(targetCwd, dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const candidates = [
    { scope: 'global', path: join(dshHome, 'AGENTS.md') },
    { scope: 'workspace', path: join(targetCwd, 'AGENTS.md') },
  ]
  const loaded = []
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    const text = readFileSync(candidate.path, 'utf8')
    if (loaded.some((entry) => entry.text === text)) continue
    loaded.push({ ...candidate, text })
  }
  if (loaded.length === 0) {
    return 'No AGENTS.md instruction file is present; continue without additional file-based instructions.'
  }
  if (loaded.length === 1) return loaded[0].text
  return loaded.map((entry) =>
    `<${entry.scope}-agents path=${JSON.stringify(entry.path)}>\n${entry.text}\n</${entry.scope}-agents>`,
  ).join('\n\n')
}

/**
 * Render one skill_search result EXACTLY as the live skill-search tool would
 * (same tokenization, cap, and wording). The template's baked skill listings
 * describe the ROLL machine's registry; a clone must instead see its own.
 */
export function renderSkillSearchResult(query, skills) {
  const tokens = (text) => (text || '').toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean)
  const wanted = tokens(query)
  const matches = skills.filter((skill) => {
    if (wanted.length === 0) return true
    const haystack = tokens(`${skill.name} ${skill.description ?? ''} ${skill.whenToUse ?? ''}`).join(' ')
    return wanted.every((token) => haystack.includes(token))
  })
  const head = matches.slice(0, 20)
  const lines = head.map((skill) => `- ${skill.name}: ${(skill.description || '').split('\n')[0]}`)
  if (lines.length === 0) return `No skills match "${query}". Use skill_search with other keywords.`
  const extra = matches.length > 20 ? `\n…(${matches.length - 20} more)` : ''
  return `Matching skills (${matches.length}):\n${lines.join('\n')}${extra}\n\nLoad one with skill_load (exact name).`
}

/** Replace every text part of one tool result with a single live-rendered text. */
function replaceResultText(event, text) {
  const block = event.data?.message?.content?.[0]
  if (!Array.isArray(block?.content)) return event
  return {
    ...event,
    data: {
      ...event.data,
      message: {
        ...event.data.message,
        content: [{ ...block, content: [{ type: 'text', text }] }],
      },
    },
  }
}

/**
 * Live-render the template's skill_search results against THIS machine's
 * registry, keyed by the template callIds. Failing listings degrade to the
 * same "unavailable" text the live tool would return, never to the roll
 * machine's catalog.
 */
export async function renderLiveSkillResults(ctx, plan, agent, cwd) {
  const results = new Map()
  const skillsService = ctx.get('skills')
  if (skillsService === undefined) return results
  let skills
  try {
    skills = await skillsService.list({ scope: agent, cwd, signal: undefined })
  } catch {
    skills = undefined
  }
  for (const event of plan) {
    if (event.type !== 'tool/call' || event.data?.name !== 'skill_search') continue
    let query = ''
    try {
      query = JSON.parse(event.data.arguments).query ?? ''
    } catch { /* malformed template call — leave untouched */ }
    if (skills === undefined) {
      results.set(event.data.callId, 'skill_search unavailable: registry listing failed at seed time. Run skill_search to list the current skills.')
      continue
    }
    results.set(event.data.callId, renderSkillSearchResult(query, skills))
  }
  return results
}

/** Build append plans for one destination without mutating the template. */
export function buildSeedPlan(template, targetCwd, agentsMd, skillResults = new Map()) {
  if (typeof targetCwd !== 'string' || targetCwd.length === 0) {
    throw new Error(`${name}: destination session has no cwd`)
  }
  return template.retained.map((sourceEvent) => {
    let event = rewriteDurableUnlocks(sourceEvent, DEFAULT_DURABLE_TOOLS)
    event = rewriteCwd(event, template.sourceCwd, targetCwd)
    if (sourceEvent.seq === template.instructionResultSeq) {
      event = replaceInstructionResult(event, agentsMd)
    }
    // The roll machine's skill catalog never travels: each skill_search result
    // is re-rendered against THIS registry (renderLiveSkillResults).
    if (event.type === 'tool/result' && skillResults.has(toolResultCallId(event))) {
      event = replaceResultText(event, skillResults.get(toolResultCallId(event)))
    }
    return event
  })
}

/** Keep ReactLoopAgent's constructor-time turn cursor aligned after in-place replay. */
export function synchronizeAgentTurnCursor(agent, session) {
  if (agent?.session !== session) throw new Error(`${name}: preset context is not bound to the destination session`)
  const phase = agent.phase
  if (agent.status !== 'idle' || phase?.kind !== 'idle' || !Number.isSafeInteger(phase.lastTurn)) {
    throw new Error(`${name}: live agent is not an idle compatible ReactLoopAgent`)
  }
  const lastTurn = (session.snapshotEvents ? session.snapshotEvents() : (session.events ?? [])).findLast((event) => event.type === 'turn/start')?.data?.turn ?? 0
  if (!Number.isSafeInteger(lastTurn) || lastTurn < 0) {
    throw new Error(`${name}: seeded transcript has an invalid final turn`)
  }
  phase.lastTurn = lastTurn
  return lastTurn
}

/** Append the compact template while remapping retained provenance seqs. */
export function seedSession(session, plan, title = READY_TITLE) {
  if ((session.snapshotEvents ? session.snapshotEvents() : (session.events ?? [])).some((event) => event.type === 'turn/start')) return false

  const seqMap = new Map()
  for (const sourceEvent of plan) {
    const sourceEventSeqs = Array.isArray(sourceEvent.sourceEventSeqs)
      ? sourceEvent.sourceEventSeqs.flatMap((seq) => seqMap.has(seq) ? [seqMap.get(seq)] : [])
      : undefined
    const opts = SURFACE_TYPES.has(sourceEvent.type)
      ? {
          surfaceOp: 'append',
          ...(sourceEventSeqs?.length > 0 ? { sourceEventSeqs } : {}),
        }
      : undefined
    const appended = opts === undefined
      ? session.append(sourceEvent.type, sourceEvent.data)
      : session.append(sourceEvent.type, sourceEvent.data, opts)
    seqMap.set(sourceEvent.seq, appended.seq)
  }
  session.append('session/title', { title })
  return true
}

/** Mount the in-place seeder for this preset composition. */
export function apply(ctx, config = {}) {
  const presetId = config.presetId ?? DEFAULT_PRESET
  const templatePath = config.templatePath ?? DEFAULT_TEMPLATE
  const title = config.title ?? READY_TITLE
  const unknownKeys = Object.keys(config).filter((key) => !['presetId', 'templatePath', 'title'].includes(key))
  if (unknownKeys.length > 0) throw new TypeError(`${name}: unknown config keys: ${unknownKeys.join(', ')}`)

  const template = loadPrefabTemplate(templatePath)
  const scheduled = new WeakSet()

  ctx.on('session/event', (session, event) => {
    // Trigger on either of two lifecycle events:
    // 1. `agent-preset/selected` — the preset picker swapped THIS preset onto
    //    an already-created blank session (the original trigger).
    // 2. A session CREATED with this preset in its header (the default preset
    //    path) never emits `agent-preset/selected` — the preset is composed at
    //    creation, not swapped. Its first `permission/preset` event therefore
    //    doubles as the "this preset is live" signal: seed on it too, so
    //    default-preset sessions start from turn 3 instead of turn 1.
    const selected = event.type === 'agent-preset/selected' && event.data?.agentPreset === presetId
    const born = event.type === 'permission/preset' && session.header?.agentPreset === presetId
    if (!selected && !born) return
    if (scheduled.has(session) || (session.snapshotEvents ? session.snapshotEvents() : (session.events ?? [])).some((item) => item.type === 'turn/start')) return
    scheduled.add(session)

    // The selection event is still being published here. A microtask is the
    // earliest non-reentrant boundary. Seeding now additionally awaits ONE
    // local registry listing (skill re-render), so the append can land a few
    // milliseconds after the selection RPC resumes — the event stream still
    // delivers every appended event, and the turn/start guard below still
    // prevents double-seeding or seeding over an already-active session.
    queueMicrotask(() => {
      ;(async () => {
        try {
          if ((session.snapshotEvents ? session.snapshotEvents() : (session.events ?? [])).some((item) => item.type === 'turn/start')) return
          const agent = ctx.get('agents')?.get(session.id)
          // ReactLoopAgent snapshots the final turn in its constructor. Preset
          // selection happens later, so validate that cursor before appending a
          // lifecycle transcript and synchronize it immediately afterwards.
          // The agent may not exist yet on the born path (creation is still
          // assembling the session) — skip cursor sync until it does; the
          // turn/start guard keeps a later double-seed from firing.
          if (agent !== undefined) synchronizeAgentTurnCursor(agent, session)
          const cwd = session.header?.cwd
          const agentsMd = loadInstructionBundle(cwd)
          const preliminary = buildSeedPlan(template, cwd, agentsMd)
          const skillResults = await renderLiveSkillResults(ctx, preliminary, agent, cwd)
          const plan = skillResults.size > 0
            ? buildSeedPlan(template, cwd, agentsMd, skillResults)
            : preliminary
          if (seedSession(session, plan, title)) {
            // The default-preset path may publish its agent while the skill
            // registry is being queried. Re-read after the await so an agent
            // created in that window receives the seeded turn cursor.
            const currentAgent = ctx.get('agents')?.get(session.id)
            if (currentAgent !== undefined) synchronizeAgentTurnCursor(currentAgent, session)
          }
        } catch (error) {
          ctx.logger?.error?.(`${name}: failed to seed session ${session.id}: ${String(error?.stack ?? error)}`)
        }
      })()
    })
  })
}
