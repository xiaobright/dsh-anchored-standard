/**
 * first-assistant-canceller — dependency-free scheduling helper for the
 * verify-runner's optional "stop after the first durable assistant message"
 * mode.
 *
 * Why a separate file: `verify-runner.mjs` imports DeepSeek Harness packages,
 * which the zero-dependency repository test suite cannot import. Keeping this
 * tiny scheduler free of those imports lets the unit tests cover the exact
 * behavior issues #56/#57 reported — the timer must ONLY exist when the mode
 * is enabled, it must cancel exactly once, and `stop()` must disarm it.
 */

/**
 * Watch an agent's durable session events and cancel the agent as soon as the
 * first `assistant/message` at or after `firstSeq` appears.
 *
 * @param options.agent - the running agent ({ session, cancel }).
 * @param options.firstSeq - events with a lower seq predate this run.
 * @param options.enabled - `false` returns `undefined` and schedules nothing.
 * @param options.intervalMs - poll interval.
 * @param options.setIntervalFn / clearIntervalFn - timer injections for tests.
 * @returns a stop handle, or `undefined` when disabled.
 */
export function createFirstAssistantCanceller({
  agent,
  firstSeq,
  enabled,
  intervalMs = 100,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  if (!enabled) return undefined
  let cancelled = false
  const handle = setIntervalFn(() => {
    if (cancelled) return
    const hit = agent?.session?.events?.some(
      (event) => event.type === 'assistant/message' && (event.seq ?? 0) >= (firstSeq ?? 0),
    )
    if (hit) {
      cancelled = true
      agent?.cancel?.({ kind: 'user' })
    }
  }, intervalMs)
  return {
    stop() {
      cancelled = true
      clearIntervalFn(handle)
    },
  }
}
