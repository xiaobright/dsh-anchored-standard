/**
 * probe-clone-runner — one-shot first-sentence anchoring probe.
 *
 * Creates a blank session on the prefab preset (the seeder hydrates the
 * bundled trajectory in place), waits for the seed, sends ONE follow-up, and
 * cancels the run as soon as the first assistant message is durable. The
 * verdict classifies only that message's first reasoning line — the affordable
 * unit of trajectory evidence after the price hike: one model request per
 * trial, no multi-step task, no second round.
 *
 * Printed as one `PROBE_RESULT: {json}` line for the outer probe-clone.mjs.
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'probe-clone-runner'

export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets']

export const Config = z.object({
  followUp: z.string().required(),
  preset: z.string().default('prefab-anchored-standard'),
  cwd: z.string().required(),
  seedTimeoutMs: z.number().default(5000),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

export const internals = { stdout: process.stdout, stderr: process.stderr }

/** First-line family of one reasoning block — the probe's dependent variable. */
function firstLineFamily(text) {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? ''
  const we = (text.match(/\bwe\b/gi) ?? []).length
  const letMe = (text.match(/\blet me\b/gi) ?? []).length
  let family = 'other'
  if (/^we\b/i.test(firstLine)) family = 'we'
  else if (/^let's\b/i.test(firstLine)) family = 'lets'
  else if (/^let me\b/i.test(firstLine)) family = 'let-me'
  else if (/^the user\b/i.test(firstLine)) family = 'user'
  else if (/^i\b/i.test(firstLine)) family = 'i'
  return { family, firstLine: firstLine.slice(0, 120), we, letMe }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(ctx, config, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const presets = ctx.get('agentPresets')
  if (agents === undefined || defaultModel === undefined || sessions === undefined || presets === undefined) {
    throw new Error('probe-clone-runner: required services not composed')
  }
  const selection = config.provider !== undefined && config.model !== undefined
    ? {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    }
    : defaultModel.currentSelection()

  const startedAt = Date.now()
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: config.cwd, agentPreset: config.preset },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await presets.mount(agentCtx, config.preset)
    },
  })
  await agent.whenIdle()

  // Headless create does not travel the UI's preset-selection RPC (the event
  // is emitted by packages/client/ui-agent-preset), so the seeder's trigger
  // never fires on its own here. Publish it explicitly now that the agent is
  // registered and the seeder's agents.get(session.id) can resolve it.
  agent.session.append('agent-preset/selected', { agentPreset: config.preset })

  // The seeder hydrates asynchronously (skill re-render); a seeded session
  // carries the template's turn/start events.
  const deadline = Date.now() + config.seedTimeoutMs
  while (Date.now() < deadline && !(agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).some((event) => event.type === 'turn/start')) {
    await sleep(25)
  }
  const seeded = (agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).some((event) => event.type === 'turn/start')
  const seededTurns = (agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).filter((event) => event.type === 'turn/start').length
  const seededUnlocks = (agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).some((event) =>
    event.type === 'tool/call' && event.data?.name === 'dev_tool_search')
  if (!seeded) {
    internals.stdout.write(`PROBE_RESULT: ${JSON.stringify({ ok: false, error: 'session did not seed within timeout', sessionId: String(agent.session.id) })}\n`)
    io.exit(4)
    return
  }
  const startSeq = agent.session.seq

  // Cancel at the first durable assistant message: the trial measures exactly
  // one request's opening trajectory, nothing past it.
  let cancelled = false
  const watch = setInterval(() => {
    if (cancelled) return
    const hit = (agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).some((event) => event.type === 'assistant/message' && event.seq >= startSeq)
    if (hit) {
      cancelled = true
      agent.cancel({ kind: 'user' })
    }
  }, 100)

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.followUp }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  clearInterval(watch)
  await sessions.flush(agent.session)

  const first = (agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).find((event) => event.type === 'assistant/message' && event.seq >= startSeq)
  if (first === undefined) {
    internals.stdout.write(`PROBE_RESULT: ${JSON.stringify({ ok: false, error: 'no assistant message recorded', sessionId: String(agent.session.id), seeded: true })}\n`)
    io.exit(5)
    return
  }
  const blocks = first.data.message?.content ?? []
  const reasoning = blocks.find((block) => block.type === 'reasoning')
  const verdict = {
    ok: true,
    sessionId: String(agent.session.id),
    seeded,
    seededTurns,
    seededUnlocks,
    model: selection.model,
    followUp: config.followUp,
    ...(reasoning === undefined
      ? { family: 'no-reasoning', firstLine: '', we: 0, letMe: 0 }
      : firstLineFamily(reasoning.text)),
    toolCallsInFirstMessage: blocks.filter((block) => block.type === 'tool-call').length,
    durationMs: Date.now() - startedAt,
  }
  internals.stdout.write(`PROBE_RESULT: ${JSON.stringify(verdict)}\n`)
  io.exit(0)
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('probe-clone-runner: launcher must provide ctx.appExit')
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error) => {
    internals.stderr.write(`probe-clone-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(3)
  })
}
