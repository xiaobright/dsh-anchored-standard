/**
 * custom-bash — a Windows-capable `bash` tool that registers under the SAME
 * name (`bash`) as the official persistent bash, with a Minimal-compatible
 * description, but executes through `ctx.subprocess.spawn` instead of a PTY.
 *
 * WHY: DeepSeek's first-request trajectory anchor keys on the tool SCHEMA
 * matching the RL training distribution (issue #11: persistent
 * bash + str_replace_editor anchored 5/5 at maxTokens=256000, pwsh/read
 * 8/8 standard-like). The official persistent bash uses a PTY, and DSH's PTY
 * backend is linux/darwin-only — `subprocess-local` throws "terminal
 * inspection is unsupported on platform win32". A custom tool that presents
 * the same name and a Minimal-like description but spawns Git Bash through
 * the ordinary (cross-platform) subprocess seam keeps the schema anchor
 * without the PTY dependency.
 *
 * Executable resolution (config `bashPath`, issue #24 — no hardcoded install
 * path): an explicit non-empty `bashPath` wins unconditionally. Unset, the
 * Git Bash executable is INFERRED, in probe order:
 *  1. the `git` executable on PATH — its install root carries `bin\bash.exe`
 *     one level up from `cmd\`, beside `bin\`, or two levels up from
 *     `mingw64\bin\` (the standard installer, choco, and winget all resolve
 *     here; a scoop SHIM does not — its directory is the shims root, not the
 *     app — which is what step 2 covers);
 *  2. the well-known Git-for-Windows roots derived from environment variables
 *     (`ProgramFiles`, `ProgramFiles(x86)`, per-user `LOCALAPPDATA\Programs
 *     \Git`, scoop's `~\scoop\apps\git\current` junction);
 *  3. plain `bash` through `ctx.subprocess.resolveExecutable` (PATH lookup —
 *     last resort, since on Windows that may pick the WSL shim; WSL bash is
 *     still true bash, only the filesystem paths shift to /mnt/…).
 *
 * If NOTHING resolves, the tool fails with an actionable error naming the
 * remedies — it does NOT silently execute under a different shell: the
 * schema above promises `bash -c` semantics, and pwsh/cmd are different
 * command languages. PowerShell stays available as its OWN tool (`pwsh`,
 * present in the promoted catalog on Windows, unlockable via
 * dev_tool_search).
 *
 * Semantics mirror the official bash tool: `bash -c <command>` in a fresh
 * process, bounded output, non-zero exit reported not thrown. No sandbox
 * confinement on Windows (the sandbox backend is linux-only); the tool
 * description says so. The bootstrap catalog pairs this with
 * `str_replace_editor` (Minimal's two tools).
 */

import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'custom-bash'

/** The subprocess and tools services must exist before this tool can register. */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

/**
 * Git Bash candidate paths, in probe order (see the header): the `git`
 * executable's install root first, then the well-known env-derived roots.
 * Exported for tests; pure — existence probing happens at the call site.
 */
export function bashCandidates(env, gitExe) {
  const candidates = []
  // git at <root>\cmd\git.exe (installer/scoop) or <root>\bin\git.exe →
  // <root>\bin\bash.exe; <root>\mingw64\bin\git.exe (portable) → two up.
  // A bare relative name means `git` did not actually resolve to a path.
  if (typeof gitExe === 'string' && /[/\\]/.test(gitExe)) {
    const dir = dirname(gitExe)
    const root = dirname(dir)
    candidates.push(
      join(root, 'bin', 'bash.exe'),
      join(dir, 'bash.exe'),
      join(dirname(root), 'bin', 'bash.exe'),
    )
  }
  if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'))
  if (env['ProgramFiles(x86)']) candidates.push(join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'))
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
  if (env.USERPROFILE) candidates.push(join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'))
  // Layouts overlap (a `bin` git.exe derives the same bash twice) — probe
  // order survives the dedupe, insertion order is preserved.
  return [...new Set(candidates)]
}

/**
 * Git Bash / MSYS drive path (`/e/foo`) → Windows path (`E:\foo`).
 * Unix paths like `/usr/bin` or `/tmp` are left unchanged. Exported for tests.
 */
export function normalizeGitBashWorkdir(workdir, platform = process.platform) {
  if (typeof workdir !== 'string' || workdir.length === 0) return workdir
  if (platform !== 'win32') return workdir
  const match = workdir.match(/^\/([a-zA-Z])(?:\/(.*))?$/)
  if (!match) return workdir
  const rest = match[2] ? match[2].replace(/\//g, '\\') : ''
  return rest ? `${match[1].toUpperCase()}:\\${rest}` : `${match[1].toUpperCase()}:\\`
}

function isWorkdirEnoent(error) {
  return /\bENOENT\b/.test(String((error && error.message) || error || ''))
}

/** Tool parameter schema for the model-facing command. */
const commandSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The bash command to execute (`bash -c` string domain).',
    },
    workdir: {
      type: 'string',
      description: 'Optional working directory; defaults to the session cwd. On Windows, Git Bash paths like /e/foo are accepted and converted to E:\\foo.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

/** Register the model-facing `bash` tool. */
export function apply(ctx, config) {
  const explicitBashPath = typeof config?.bashPath === 'string' && config.bashPath.length > 0 ? config.bashPath : undefined
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(config?.maxOutputBytes) && config.maxOutputBytes > 0 ? config.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  // The inferred executable is memoized per plugin instance: candidate probing
  // walks the filesystem, and the answer cannot change within a mount. A
  // failed inference is NOT memoized — the plain `bash` fallback resolves
  // fresh on every execute until some probe succeeds.
  let inferredShell
  const exists = (path) => access(path).then(() => true, () => false)
  const resolveShell = async (signal) => {
    if (explicitBashPath !== undefined) {
      // A misconfigured explicit path must fail as itself, not as a
      // discovery miss — the raw resolution error says which path failed.
      return ctx.subprocess.resolveExecutable(explicitBashPath, undefined, signal)
    }
    if (inferredShell !== undefined) {
      return ctx.subprocess.resolveExecutable(inferredShell, undefined, signal)
    }
    let gitExe
    try {
      gitExe = await ctx.subprocess.resolveExecutable('git', undefined, signal)
    } catch {
      // git unresolvable → the env-derived candidates below still apply
    }
    for (const candidate of bashCandidates(process.env, gitExe)) {
      if (!(await exists(candidate))) continue
      try {
        inferredShell = await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
        return inferredShell
      } catch {
        // Exists but unresolvable (EPERM, a broken scoop junction): keep
        // probing — one bad root must not block the rest of the chain, and
        // nothing is memoized so later executes can still find a good one.
        continue
      }
    }
    try {
      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)
    } catch (error) {
      // Total discovery failure (no Git Bash root, no env root, no bash on
      // PATH): name the remedies instead of leaking a raw ENOENT. Never
      // fall back to pwsh/cmd here — the schema promises `bash -c`
      // semantics; a different shell would silently break every command.
      throw new Error(`bash executable not found — install Git for Windows, expose a bash on PATH, or set the custom-bash \`bashPath\` config (${String((error && error.message) || error)})`)
    }
  }

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
      '* NOTE: runs without OS sandbox confinement on Windows (no landlock); treat output as untrusted.',
      '* workdir accepts a Windows path or a Git Bash drive path (/e/foo).',
    ].join('\n'),
    parameters: commandSchema,
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
      const shell = await resolveShell(exec?.signal)
      const sessionCwd = exec?.agent?.session?.header?.cwd
      const requested = typeof args.workdir === 'string' && args.workdir.length > 0
        ? args.workdir
        : sessionCwd
      const workdir = normalizeGitBashWorkdir(requested)
      const signal = exec?.signal
      const spawnOnce = (cwd) => ctx.subprocess.spawn({
        argv: [shell, '-c', args.command],
        ...cwd !== undefined ? { cwd } : {},
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        ...signal !== undefined ? { signal } : {},
        graceMs: 3000,
      })
      let handle
      let outcome
      let usedFallback = false
      try {
        handle = spawnOnce(workdir)
        outcome = await handle.done
      } catch (error) {
        const fallback = sessionCwd !== undefined ? normalizeGitBashWorkdir(sessionCwd) : undefined
        if (
          requested !== undefined
          && fallback !== undefined
          && fallback !== workdir
          && isWorkdirEnoent(error)
        ) {
          usedFallback = true
          try {
            handle = spawnOnce(fallback)
            outcome = await handle.done
          } catch (retryError) {
            throw new Error(`bash spawn failed: ${String(retryError)}`)
          }
        } else {
          // A spawn-level failure (bad executable, EPERM) surfaces as a throw,
          // which the runtime turns into an isError result.
          throw new Error(`bash spawn failed: ${String(error)}`)
        }
      }
      let stdout = ''
      let stderr = ''
      try {
        stdout = handle.collected.stdout.readFrom(0).text
        stderr = handle.collected.stderr.readFrom(0).text
      } catch {
        // Collected readers may be unavailable on some backends; tolerate.
      }
      const note = usedFallback
        ? `[custom-bash] workdir ${requested} was unusable (ENOENT); fell back to session cwd\n`
        : ''
      const text = [stdout, stderr].filter((part) => part.length > 0).join('\n')
      const tail = note + (text.length > 0 ? text : `exit code: ${outcome.exitCode} (no output)`)
      if (outcome.exitCode !== 0) {
        // Non-zero exit is a reported failure, not a throw: the model sees the
        // command output plus the exit code.
        throw new Error(tail)
      }
      return { text: tail }
    },
  })
}
