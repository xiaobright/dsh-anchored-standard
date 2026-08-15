/**
 * gitbash-tool — the Windows `bash` tool for presets backed by
 * gitbash-executor.mjs, with the MINIMAL-compatible model surface.
 *
 * The first-request trajectory anchor keys on the API-visible bash schema and
 * description, so this tool registers `bash` with exactly `command` + optional
 * `workdir` and a Minimal-style description. The ENGINE remains
 * gitbash-executor — Git Bash auto-detection, MSYS path conversion for
 * workdir, full-access sandbox gate, bounded/spilled output, timeout and
 * grace handling — so the model surface and the execution backend are
 * decoupled. The plugin uses a raw `ctx.tools.register()` definition (like
 * `custom-bash.mjs`) so it has no package dependency.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'gitbash-tool'

/** The entry-local shell executor and the tools registry must exist. */
export const inject = ['shell', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

function positiveInt(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/** Register the model-facing `bash` tool on top of the gitbash executor. */
export function apply(ctx, config = {}) {
  const timeoutMs = positiveInt(config.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS)
  const stdoutMaxBytes = positiveInt(config.maxOutputBytes, 'maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES)
  const shell = ctx.shell
  if (shell === undefined) {
    throw new Error(`${name}: ctx.shell is unavailable`)
  }
  const defaultMode = shell.sandboxMode
  const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error(`${name}: the mounted bash executor confines but ctx.sandboxPolicy is missing`)
  }

  /**
   * Resolve the session's STANDING sandbox policy before execution. The
   * session-level preset switch is durable (`sandbox/mode` events), so the
   * executor's `sandboxPolicy.resolve()` MUST be given the calling session;
   * resolving without one only sees the deployment default and wrongly
   * rejects a session that already switched to full access.
   */
  const resolveSandboxPolicy = (exec) => sandboxPolicy === undefined
    ? undefined
    : sandboxPolicy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (Git Bash on Windows)',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      "* You don't have access to the internet via this tool.",
      '* You do have access to a mirror of common linux and python packages via apt and pip.',
      '* State does NOT persist across command calls: each call runs in a fresh shell.',
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      '* Please avoid commands that may produce a very large amount of output.',
      '* NOTE: the MSYS runtime requires the full-access sandbox; it cannot start under restricted modes.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute (`bash -c` string domain).',
        },
        workdir: {
          type: 'string',
          description: 'Optional working directory; defaults to the session cwd.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const command = typeof args.command === 'string' ? args.command : ''
      if (command.trim().length === 0) throw new Error('command must be a non-empty string')
      const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
        ? args.workdir
        : exec?.agent?.session?.header?.cwd
      const standingPolicy = resolveSandboxPolicy(exec)
      const request = {
        command,
        ...workdir !== undefined ? { workdir } : {},
        timeoutMs,
        stdoutMaxBytes,
        ...standingPolicy === undefined ? {} : { sandboxPolicy: standingPolicy },
      }
      const spec = shell.resolve(request)
      const result = await shell.run({
        ...spec,
        ...exec?.signal !== undefined ? { signal: exec.signal } : {},
      })

      if (result.aborted === true) throw new Error('bash call aborted')
      const stdout = result.stdout?.text ?? ''
      const stderr = result.stderr?.text ?? ''
      const text = [stdout, stderr].filter(part => part.length > 0).join('\n')
      if (result.timedOut === true) {
        throw new Error(`bash timed out after ${result.timeoutMs}ms${text.length > 0 ? `:\n${text}` : ''}`)
      }
      if (result.exitCode !== 0) {
        const tail = text.length > 0 ? text : `exit code: ${result.exitCode} (no output)`
        throw new Error(tail)
      }
      return { text }
    },
  })
}
