/**
 * verify-runner — one-shot CLI driver for testing an agent preset against a
 * real model endpoint on the installed DeepSeek Harness.
 *
 * Unlike the shipped `headless` runner, this plugin composes the agent from an
 * agent-preset roster (`AgentPresets.mount`), so the session exercises the
 * exact preset composition the Web UI would mount — including the
 * `tool-bootstrap` phase filter. It exists only for verification: it drives
 * one task, prints the durable `request/header` events (config,
 * adapterDefaults, tool names) plus the first assistant message's content,
 * and exits. It is not part of the preset itself.
 *
 * Mount it into a profile with a `--patch` overlay that also inserts the
 * `agent-presets` roster row (see run-verify.mjs in this directory).
 *
 * Config fields:
 *  - `task`: the prompt text for the single run (required).
 *  - `preset`: preset id to compose (default `anchored-standard`).
 *  - `cwd`: session working directory (default: the launcher's cwd).
 *  - `provider` / `model` / `reasoningEffort`: optional model route,
 *    overriding the deployment's `agent-default-model` selection for this run.
 *  - `stopAfterFirstAssistant`: cancel the run as soon as the first
 *    `assistant/message` is durable, matching the issue-#11 methodology of
 *    measuring only the FIRST model request (default false).
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createFirstAssistantCanceller } from './first-assistant-canceller.mjs'

/** Stable Cordis plugin name. */
export const name = 'verify-runner'

/** Core services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets']

export const Config = z.object({
  task: z.string().required(),
  preset: z.string().default('anchored-standard'),
  cwd: z.string().default(process.cwd()),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  stopAfterFirstAssistant: z.boolean().default(false),
})

export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
}

function fail(io, error) {
  io.stderr.write(`verify-runner: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/** One line of a request header: which config and tools one model request used. */
function headerLine(header) {
  const config = header?.config ?? {}
  const defaults = header?.adapterDefaults ?? {}
  const tools = Array.isArray(header?.tools) ? header.tools.map((tool) => tool?.name) : []
  return JSON.stringify({ config, adapterDefaults: defaults, tools })
}

/**
 * Run one task through a fresh agent composed from a preset and print a
 * verification report: every request/header change plus the first assistant
 * message content.
 */
async function run(ctx, config, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const presets = ctx.get('agentPresets')
  if (agents === undefined || defaultModel === undefined || sessions === undefined || presets === undefined) {
    throw new Error('verify-runner: required services not composed (agents, agentDefaultModel, sessions, agentPresets)')
  }

  const selection = config.provider !== undefined && config.model !== undefined
    ? {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    }
    : defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: config.cwd, agentPreset: config.preset },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      const selected = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
      await presets.mount(agentCtx, config.preset)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq

  // Optional: cancel as soon as the first assistant message is durable, so a
  // verbose multi-tool run does not burn the whole task budget. The watcher is
  // scheduled ONLY when the mode is enabled (issues #56/#57): with the default
  // `stopAfterFirstAssistant: false` the run must continue through promotion.
  const firstAssistantWatch = createFirstAssistantCanceller({
    agent,
    firstSeq,
    enabled: config.stopAfterFirstAssistant,
  })

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  firstAssistantWatch?.stop()
  await sessions.flush(agent.session)

  // Report: session identity, every request header, then the first assistant reply.
  const out = []
  out.push(`sessionId: ${agent.session.id}`)
  out.push(`preset: ${config.preset}`)
  out.push(`cwd: ${config.cwd}`)
  for (const event of agent.session.events) {
    if (event.type !== 'request/header') continue
    out.push(`request/header [${event.data.reason}] ${headerLine(event.data.header)}`)
  }
  const firstAssistant = agent.session.events.find((event) => event.type === 'assistant/message' && event.seq >= firstSeq)
  if (firstAssistant === undefined) {
    out.push('(no assistant/message recorded)')
  } else {
    const blocks = (firstAssistant.data.message?.content ?? []).map((block) => {
      if (block.type === 'text') return `text: ${block.text}`
      if (block.type === 'reasoning') return `reasoning: ${block.text}`
      return `block: ${JSON.stringify(block)}`
    })
    out.push(`first assistant/message (${blocks.length} blocks):`)
    for (const line of blocks) out.push(line)
  }
  // Which user-message sources reached the first step: the bootstrap strip
  // removes agent-instructions and skill-catalog until promotion.
  const beforeAssistant = agent.session.events.filter(
    (event) => event.seq >= firstSeq && event.seq < (firstAssistant?.seq ?? Number.POSITIVE_INFINITY),
  )
  const userSources = beforeAssistant
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data.message?.source?.kind ?? 'unknown')
  out.push(`first-step user message sources: ${JSON.stringify(userSources)}`)
  const turnEnd = [...agent.session.events].reverse().find((event) => event.type === 'turn/end')
  out.push(`turn/end: ${JSON.stringify(turnEnd?.data?.reason ?? null)}`)
  io.stdout.write(out.join('\n') + '\n')
  io.exit(0)
}

/**
 * Mount the one-shot verify runner.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task config.
 */
export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('verify-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error) => { fail(io, error) })
}
