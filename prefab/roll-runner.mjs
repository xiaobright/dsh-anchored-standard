/**
 * roll-runner — two-phase prefab roller plugin for the headless profile.
 *
 * Phase 1 sends a work-style anchor task (the known 8/8 probe prompt) and
 * classifies every assistant reasoning block. Phase 2 sends the loading task
 * (unlock tools, read AGENTS.md, survey skills) and classifies again. A roll
 * succeeds only when NO reasoning block degrades to the let-me family and the
 * durable log actually carries the unlock flow, the AGENTS.md read, and skill
 * searches. The verdict is printed as one `PREFAB_RESULT: {json}` line for the
 * outer roller to parse; the process exits 0 either way.
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'roll-runner'

export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets']

export const Config = z.object({
  anchorTask: z.string().required(),
  loadTask: z.string().default(''),
  preset: z.string().default('anchored-standard'),
  cwd: z.string().required(),
  sessionId: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

export const internals = { stdout: process.stdout, stderr: process.stderr }

/** One reasoning block's trajectory verdict — hard-fail on let-me or the
 *  first-person family. "The user …" openers are the NORMAL voice of follow-up
 *  turns (turn-shape dependence, request-2 pilot) and are recorded, not
 *  failed; the anchor turn's own first block must still open "We". */
function classify(text) {
  const trimmed = text.trim()
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? ''
  const we = (trimmed.match(/\bwe\b/gi) ?? []).length
  const letMe = (trimmed.match(/\blet me\b/gi) ?? []).length
  const weTotal = (trimmed.match(/\bwe\b|\blet's\b|\bneed\b/gi) ?? []).length
  const degraded = letMe > 0
    || /^let me\b/i.test(firstLine)
    || /^i (need|should|'ll|will|have)\b/i.test(firstLine)
  return { ok: !degraded, weFirst: /^we\b/i.test(firstLine), userFirst: /^the user\b/i.test(firstLine), firstLine, we, letMe, weTotal }
}

function verdictLine(parts) {
  internals.stdout.write(`PREFAB_RESULT: ${JSON.stringify(parts)}\n`)
}

async function run(ctx, config, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const presets = ctx.get('agentPresets')
  if (agents === undefined || defaultModel === undefined || sessions === undefined || presets === undefined) {
    throw new Error('roll-runner: required services not composed')
  }
  const ownerCtx = ctx
  const selection = config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model, ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort } }
    : defaultModel.currentSelection()
  const setup = async (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
    await presets.mount(agentCtx, config.preset)
  }
  const { agent } = config.sessionId !== undefined
    ? await agents.resume({
      resumeSessionId: SessionId(config.sessionId),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
    : await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: config.cwd, agentPreset: config.preset },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
  await agent.whenIdle()
  const startSeq = agent.session.seq

  const messages = []
  const collectedSeqs = new Set()
  const collect = () => {
    for (const event of (agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? []))) {
      if (event.seq < startSeq || event.type !== 'assistant/message') continue
      if (collectedSeqs.has(event.seq)) continue
      const reasoning = (event.data.message?.content ?? []).find((block) => block.type === 'reasoning')
      if (reasoning !== undefined) {
        collectedSeqs.add(event.seq)
        messages.push({ seq: event.seq, text: reasoning.text })
      }
    }
  }

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.anchorTask }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  collect()
  const anchorCount = messages.length

  if (config.loadTask.length > 0) {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: config.loadTask }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    collect()
  }
  await sessions.flush(agent.session)

  const classified = messages.map((m) => ({ ...classify(m.text), seq: m.seq }))
  const styleOk = classified.length > 0 && classified.every((c) => c.ok)
  // The anchor turn's FIRST block is the trajectory the whole template sells:
  // it must open in the collaborative voice even when later steps narrate.
  const anchorWeFirst = classified.length > 0 && classified[0].weFirst
  const effectiveReasoningCount = (agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).filter((event) =>
    event.seq >= startSeq
    && event.type === 'assistant/message'
    && event.data.message?.content?.some((block) => block.type === 'reasoning')
    && event.data.message?.content?.some((block) => block.type === 'tool-call'),
  ).length

  let unlockedNames = []
  let readAgentsMd = false
  let skillSearched = false
  for (const event of (agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? []))) {
    if (event.seq < startSeq) continue
    if (event.type !== 'tool/call') continue
    if (event.data.name === 'dev_tool_search') {
      try {
        const args = JSON.parse(event.data.arguments)
        if (Array.isArray(args.toolNames)) unlockedNames.push(...args.toolNames)
      } catch { /* malformed arguments already tested elsewhere */ }
    }
    if ((event.data.name === 'bash' || event.data.name === 'str_replace_editor' || event.data.name === 'read')
      && /AGENTS\.md/i.test(String(event.data.arguments))) readAgentsMd = true
    if (event.data.name === 'skill_search') skillSearched = true
  }
  unlockedNames = [...new Set(unlockedNames)]
  const flowOk = unlockedNames.length > 0 && readAgentsMd && skillSearched
  const richEnough = effectiveReasoningCount >= 5

  verdictLine({
    sessionId: String(agent.session.id),
    cwd: config.cwd,
    preset: config.preset,
    model: selection.model,
    anchorCount,
    totalReasoning: classified.length,
    styleOk,
    anchorWeFirst,
    flowOk,
    ok: styleOk && anchorWeFirst && flowOk && richEnough,
    unlockedNames,
    readAgentsMd,
    skillSearched,
    effectiveReasoningCount,
    richEnough,
    firstLines: classified.map((c) => c.firstLine.slice(0, 100)),
    letMeHits: classified.filter((c) => !c.ok).length,
  })
  io.exit(0)
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('roll-runner: launcher must provide ctx.appExit')
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error) => {
    internals.stderr.write(`roll-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    verdictLine({ ok: false, error: String(error instanceof Error ? error.message : error) })
    io.exit(3)
  })
}
