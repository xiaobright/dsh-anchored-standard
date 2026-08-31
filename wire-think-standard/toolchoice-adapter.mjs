/**
 * Think-route adapter — a sibling DeepSeek route that puts `tool_choice: "none"`
 * on the wire, the ONE condition the official adapter cannot express
 * (GenerateOptions has no tool_choice vocabulary; `dsh-llm-deepseek` documents
 * the mapping as an MVP cut).
 *
 * Keeping the tool definitions in the prompt while the wire forbids
 * invocation preserves the model's full planning context during deliberation
 * — a think condition worth reaching from a preset-local plugin:
 *
 *  - It registers under its OWN provider id (default `deepseek-wire-think`);
 *    re-registering `deepseek-official` would throw DUPLICATE_ADAPTER, and
 *    the official DeepSeekAdapter cannot be wrapped (its wire body is built
 *    inside a private generator with no seam).
 *  - `agent/request` (see wire-think.mjs) routes THINK steps here and routes
 *    every other step back to the official provider, so tool-bearing steps
 *    keep the battle-tested official transport. This adapter only ever needs
 *    to be wire-correct for THINK requests, but it implements the full
 *    message vocabulary (history can contain earlier tool turns).
 *  - Config resolution mirrors the official row: row config first, then the
 *    `llm-deepseek` settings section (`ctx.settings.describe()`), then env
 *    (`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`). The key resolves through
 *    `ctx.credentials` when available, else the trusted environment.
 *
 * Zero dependencies by design: preset directories are copied alone into
 * `.agent-presets/`, so this file vendors a minimal, protocol-faithful
 * subset of the official serialize/SSE/translate pipeline (MIT; DeepSeek's
 * copyright notice is retained in NOTICE) instead of importing
 * `@deepseek-ai/*` or `eventsource-parser`. Simplifications vs. the official
 * adapter, all deliberate and documented:
 *  - no idle watchdog (caller signal still honored end-to-end);
 *  - plain `Error`s with `.code` fields (the llm runtime normalizes any
 *    thrown adapter error into a terminal error finish);
 *  - `logprobs` (opt-in research hook): the DeepSeek wire has no harness
 *    StreamChunk surface for logprob data, so the adapter can only request
 *    it and LOG a per-request summary — an offline trajectory-analysis feed.
 *
 * Registering the same provider id twice (two presets both mounting this row)
 * throws DUPLICATE_ADAPTER at mount; the plugin catches that, warns once,
 * and leaves the engine to degrade to the zero-tool think condition.
 *
 * Named gateway support: the same vendored wire pipeline can point at a
 * named OpenAI-compatible gateway instead of the DeepSeek endpoint. Setting
 * `gateway: "orcarouter"` routes this adapter at the OrcaRouter gateway
 * (https://api.orcarouter.ai/v1) with the `ORCAROUTER_API_KEY` env var and
 * the `vendor/model` model namespace (e.g. `deepseek/deepseek-chat`, or the
 * adaptive `orcarouter/auto` router), so the think-route condition reproduces
 * over a gateway that adds adaptive routing, automatic failover, zero-markup
 * inference, observability, and guardrails on the same endpoint. Row config
 * still wins: an explicit `baseURL` / `apiKeyEnv` overrides the gateway
 * defaults. The DeepSeek default is untouched when `gateway` is unset.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'toolchoice-adapter'

/** The llm registry must exist before this plugin can register a route. */
export const inject = ['llm']

/** Default provider route id this adapter owns. */
export const DEFAULT_PROVIDER = 'deepseek-wire-think'

/** Default DeepSeek endpoint (same fallback chain as the official row). */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** The terminal SSE sentinel (DeepSeek and OpenAI both send it). */
const DONE = '[DONE]'

/**
 * Named OpenAI-compatible gateways this adapter can route at. Each entry
 * pins the endpoint, the key env var, the provider label, and the advisory
 * model namespace. Row config (`baseURL` / `apiKeyEnv`) still wins over
 * these defaults.
 */
const GATEWAYS = {
  orcarouter: {
    baseURL: 'https://api.orcarouter.ai/v1',
    apiKeyEnv: 'ORCAROUTER_API_KEY',
    providerName: 'OrcaRouter (community think route)',
    userAgent: 'orcarouter-harness-community-think-route-adapter/0.1.0 (dsh-plugin)',
    catalogModels: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'orcarouter/auto'],
  },
}

/** Advisory models — identical wire ids to the official catalog defaults. */
const CATALOG_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash']

/** Resolve the advisory catalog for the active gateway (default DeepSeek). */
function catalogModels(gateway) {
  return gateway?.catalogModels ?? CATALOG_MODELS
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve one operation's connection facts. With a named gateway the
 * endpoint and key env are pinned by the gateway entry (row config still
 * wins); otherwise the DeepSeek fallback chain applies: row config >
 * `llm-deepseek` settings section > environment. Re-read per request so a
 * settings change reaches the next call without re-registration.
 */
function resolveConnection(ctx, config, gateway) {
  let baseURL = nonEmptyString(config?.baseURL)
  let apiKeyEnv = nonEmptyString(config?.apiKeyEnv)
  if (gateway !== undefined) {
    // A named gateway pins its endpoint and key env; row config still wins.
    baseURL ??= gateway.baseURL
    apiKeyEnv ??= gateway.apiKeyEnv
    return { baseURL: baseURL.replace(/\/+$/, ''), apiKeyEnv }
  }
  if (baseURL === undefined || apiKeyEnv === undefined) {
    try {
      const described = ctx.get('settings')?.describe?.() ?? []
      const section = described.find((entry) => entry?.ns === 'llm-deepseek')?.value
      if (section !== null && typeof section === 'object') {
        baseURL ??= nonEmptyString(section.baseURL)
        apiKeyEnv ??= nonEmptyString(section.apiKeyEnv)
      }
    } catch {
      // Settings service unavailable — env fallback below.
    }
  }
  baseURL ??= nonEmptyString(process.env.DEEPSEEK_BASE_URL) ?? DEFAULT_BASE_URL
  apiKeyEnv ??= 'DEEPSEEK_API_KEY'
  return { baseURL: baseURL.replace(/\/+$/, ''), apiKeyEnv }
}

/**
 * Resolve the named gateway entry; an unknown name is a config error (fail
 * the mount loudly, never silently fall back to the DeepSeek default).
 */
function parseGateway(value) {
  if (value === undefined) return undefined
  const gateway = GATEWAYS[value]
  if (gateway === undefined) {
    throw new TypeError(`${name}: gateway must be one of ${Object.keys(GATEWAYS).join(', ')}, got ${JSON.stringify(value)}`)
  }
  return gateway
}

/** Resolve the bearer token: credentials service first, trusted env second. */
async function resolveApiKey(ctx, apiKeyEnv) {
  try {
    const credentials = ctx.get('credentials')
    const resolved = await credentials?.resolve?.(apiKeyEnv)
    const value = typeof resolved === 'string'
      ? resolved
      : typeof resolved?.value === 'string'
        ? resolved.value
        : undefined
    if (value !== undefined && value.length > 0) return value
  } catch {
    // Fall through to the environment.
  }
  const envValue = process.env[apiKeyEnv]
  if (envValue !== undefined && envValue.length > 0) return envValue
  const error = new Error(`Think-route adapter: no API key resolved for ${apiKeyEnv}`)
  error.code = 'MISSING_CREDENTIAL'
  throw error
}

// ── vendored serializer (minimal port of dsh-llm-deepseek serialize.ts) ─────

/** Join the text blocks of a message. */
function flattenText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function hasImage(blocks) {
  return (Array.isArray(blocks) ? blocks : []).some((block) => block?.type === 'image')
}

/** Serialize one assistant message (text "" never null; reasoning rides only tool-call turns). */
function serializeAssistant(message) {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  const toolCalls = message.content
    .filter((block) => block?.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) },
    }))
  return {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/** Serialize the conversation; tool results expand into standalone role:'tool' messages. */
function serializeMessages(messages) {
  const wire = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (hasImage(message.content)) {
      const error = new Error('Think-route adapter: image content is not supported on this wire route')
      error.code = 'UNSUPPORTED_CONTENT'
      throw error
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter((block) => block?.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** Resolve the thinking/effort wire fields (title calls never think). */
function resolveThinking(options) {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return {}
}

/**
 * Build the wire request. The think-route addition over the official serializer:
 * `tool_choice` when tool definitions are present (default 'none').
 */
export function serializeThinkRequest(options, config) {
  const messages = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools = Array.isArray(options.tools) && options.tools.length > 0
    ? options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    : undefined
  const thinking = resolveThinking(options)
  const toolChoice = tools !== undefined ? (config?.toolChoice ?? 'none') : undefined

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(thinking.thinking !== undefined ? { thinking: { type: thinking.thinking } } : {}),
    ...(thinking.reasoningEffort !== undefined ? { reasoning_effort: thinking.reasoningEffort } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
    ...(config?.logprobs === true ? { logprobs: true, top_logprobs: 1 } : {}),
  }
}

// ── vendored SSE parser (hand-rolled; no eventsource-parser dependency) ─────

/**
 * Decode an SSE byte stream into `data` payloads, yielding `[DONE]` last.
 * Framing follows the event-stream spec: an event dispatches only on its
 * blank-line terminator; CRLF is normalized; non-data fields are skipped.
 * EOF before `[DONE]` is truncation and throws.
 */
export async function* parseSseStream(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (dataLines.length > 0) {
            const data = dataLines.join('\n')
            dataLines = []
            yield data
            if (data === DONE) return
          }
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        newline = buffer.indexOf('\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Reader already released — nothing to do.
    }
  }
  const error = new Error('Think-route adapter: SSE stream ended without [DONE]')
  error.code = 'STREAM_CLOSED'
  throw error
}

// ── vendored translator (minimal port of dsh-llm-deepseek translate.ts) ─────

/** Map the wire finish_reason vocabulary onto the harness FinishReason. */
function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } }
  }
}

/** Map wire usage to disjoint harness counts (cache reads subtracted). */
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: (usage.prompt_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

/**
 * Translate SSE payloads (ending with `[DONE]`) into harness StreamChunks.
 * Deltas stream out live; block-ends, usage, and finish defer to the
 * sentinel. An optional `onLogprobs` receives the collected token logprob
 * samples of the request (the logprobs research hook).
 */
export async function* translateChunks(payloads, onLogprobs) {
  let nextIndex = 0
  const order = []
  const blocks = { text: undefined, reasoning: undefined }
  const toolBlocks = new Map()
  let pendingFinish
  let pendingUsage
  let logprobSum = 0
  let logprobCount = 0

  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '', callId: undefined, name: undefined }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        const closed = block.kind === 'text'
          ? { type: 'text', text: block.text }
          : block.kind === 'reasoning'
            ? { type: 'reasoning', text: block.text }
            : { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text }
        yield { type: 'block-end', index: block.index, block: closed }
      }
      if (onLogprobs !== undefined && logprobCount > 0) onLogprobs(logprobSum / logprobCount, logprobCount)
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } }
          : reason,
      }
      return
    }

    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      const error = new Error(`Think-route adapter: malformed SSE payload: ${payload.slice(0, 120)}`)
      error.code = 'MALFORMED_RESPONSE'
      throw error
    }

    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (blocks.reasoning === undefined) {
          blocks.reasoning = open('reasoning')
          yield { type: 'block-start', index: blocks.reasoning.index, blockType: 'reasoning' }
        }
        blocks.reasoning.text += reasoning
        yield { type: 'reasoning-delta', index: blocks.reasoning.index, text: reasoning }
      }
      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (blocks.text === undefined) {
          blocks.text = open('text')
          yield { type: 'block-start', index: blocks.text.index, blockType: 'text' }
        }
        blocks.text.text += content
        yield { type: 'text-delta', index: blocks.text.index, text: content }
      }
      for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId ?? '',
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
      // The logprobs research hook: collect token logprob samples when the
      // opt-in wire flag made the backend attach them.
      const logprobs = choice.logprobs?.content
      if (Array.isArray(logprobs)) {
        for (const sample of logprobs) {
          if (typeof sample?.logprob === 'number' && Number.isFinite(sample.logprob)) {
            logprobSum += sample.logprob
            logprobCount += 1
          }
        }
      }
    }
    if (chunk.usage !== undefined && chunk.usage !== null) pendingUsage = mapUsage(chunk.usage)
  }

  const error = new Error('Think-route adapter: payload stream ended without [DONE]')
  error.code = 'STREAM_CLOSED'
  throw error
}

/**
 * Register the sibling `tool_choice`-capable route — the DeepSeek think
 * route by default, or a named OpenAI-compatible gateway (`gateway:
 * "orcarouter"`).
 */
export function apply(ctx, config) {
  const provider = nonEmptyString(config?.provider) ?? DEFAULT_PROVIDER
  const gateway = parseGateway(config?.gateway)
  const logprobs = config?.logprobs === true
  const providerName = gateway?.providerName ?? 'DeepSeek (community think route)'
  const models = catalogModels(gateway)
  const userAgent = gateway?.userAgent ?? 'deepseek-harness-community-think-route-adapter/0.1.0 (dsh-plugin)'

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

  const adapter = {
    providerInfo(id) {
      return { id, name: providerName }
    },
    providerRetryPolicy() {
      return undefined
    },
    async listModels(id) {
      return models.map((model) => ({
        provider: id,
        id: model,
        name: model,
        inputModalities: ['text'],
      }))
    },
    async resolveModel(id, model) {
      return {
        provider: id,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: 1_000_000 },
        defaultMaxTokens: 256_000,
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'high',
        },
      }
    },
    async * stream(options) {
      const connection = resolveConnection(ctx, config, gateway)
      const apiKey = await resolveApiKey(ctx, connection.apiKeyEnv)
      const body = serializeThinkRequest(options, { toolChoice: config?.toolChoice, logprobs })
      const headers = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': userAgent,
        ...(options.sessionId !== undefined ? { 'x-deepseek-harness-session-id': String(options.sessionId) } : {}),
        ...(options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {}),
      }

      let response
      try {
        response = await fetch(`${connection.baseURL}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        const wrapped = new Error(`Think-route adapter: request to ${connection.baseURL} failed`)
        wrapped.code = 'TRANSPORT'
        wrapped.cause = error
        throw wrapped
      }

      if (!response.ok) {
        let message = `Think-route adapter: HTTP ${response.status}`
        try {
          const parsed = await response.json()
          if (parsed?.error?.message) message = parsed.error.message
        } catch {
          // Malformed gateway JSON must not mask the status.
        }
        const wrapped = new Error(message)
        wrapped.code = response.status === 401 || response.status === 403
          ? 'AUTH'
          : response.status === 429
            ? 'RATE_LIMIT'
            : response.status === 400
              ? 'INVALID_REQUEST'
              : response.status >= 500
                ? 'SERVER'
                : `HTTP_${response.status}`
        throw wrapped
      }
      if (response.body === null || response.body === undefined) {
        const wrapped = new Error('Think-route adapter: no response body')
        wrapped.code = 'EMPTY_RESPONSE'
        throw wrapped
      }

      const onLogprobs = logprobs
        ? (mean, count) => {
          try {
            ctx.logger.info(`toolchoice-adapter: logprobs summary — mean=${mean.toFixed(4)} tokens=${count}`)
          } catch {
            // Logging is best-effort telemetry only.
          }
        }
        : undefined
      yield* translateChunks(parseSseStream(response.body), onLogprobs)
    },
  }

  try {
    ctx.llm.registerAdapter([provider], adapter)
  } catch (error) {
    warnOnce(`${name}: registering provider "${provider}" failed (${String((error && error.message) || error)}); the wire-think engine will degrade to the zero-tool think condition`)
  }
}
