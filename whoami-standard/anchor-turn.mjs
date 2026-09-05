/**
 * Seed ONE anchor turn ahead of the user's very first real message.
 *
 * The anchor is PREPENDED to the `next-turn` inbox queue ahead of the real
 * message, and dsh claims exactly ONE `next-turn` message per turn, so the
 * first real model request is the fixed anchor prompt on an EMPTY tool
 * surface (see zero-tool-bootstrap.mjs) — either the zero-anchored test
 * notice (default text) or the whoami self-introduction round (`text`
 * configured to "你是谁") — while the user's actual message stays queued and
 * is claimed by the NEXT turn; by then the bootstrap has promoted and the
 * full Standard catalog is unlocked.
 *
 * Anchoring on the first user message — instead of at session creation — keeps
 * the blank-session preset switcher usable before the user types anything.
 *
 * By default subagents are skipped so their first request can use tools
 * immediately. Set `includeSubagents: true` to make subagents also take the
 * anchor turn.
 *
 * Durability is free: the prepend goes through `agent/inbox/spliced` event
 * persistence, so a crash between the anchor and the real message resumes the
 * queue in order, and the inbox replay does not fire `inserted` notifications,
 * so the anchor is never re-injected.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchor-turn'

/** Default anchor text shown to the model in the synthetic first user turn. */
export const ANCHOR_TEXT = 'This round is a test. Tools are not open yet; all tools will open next round.'

/** Fresh sessions (no prior user message) get the anchor turn. */
function isFreshSession(agent, includeSubagents = false) {
  if (!includeSubagents && (agent.session.header.delegationDepth ?? 0) > 0) return false
  return !(agent.session.snapshotEvents ? agent.session.snapshotEvents() : (agent.session.events ?? [])).some((event) => event.type === 'user/message')
}

/** Register the first-message anchor injection. */
export function apply(ctx, config) {
  const text = typeof config.text === 'string' && config.text.length > 0
    ? config.text
    : ANCHOR_TEXT
  const includeSubagents = config?.includeSubagents === true

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isFreshSession(agent, includeSubagents)) return
    // Never re-anchor on plugin-sourced messages (including our own anchor).
    if (message.source?.kind === 'plugin') return
    agent.inbox.prepend('next-turn', {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'anchor-turn',
        form: 'notice',
        summary: 'zero-tool anchor turn',
      },
    })
  })
}
