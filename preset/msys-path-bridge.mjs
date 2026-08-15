/**
 * msys-path-bridge — translate MSYS drive paths (`/c/...`, `/d/...`) into
 * Windows-native paths (`C:\...`, `D:\...`) at the TOOL REGISTRY layer.
 *
 * Git Bash models naturally produce `/c/Users/...` paths, while the harness's
 * file tools (`read`, `write`, `edit`, `grep`, `glob`, `read_image`, and the
 * bootstrap `str_replace_editor`) run against the Windows filesystem seam and
 * would resolve `/c/...` as `C:\c\...`. This plugin wraps those tool
 * definitions so path arguments are normalized before the original body
 * executes; schemas and descriptions are inherited unchanged, so the model
 * sees the original surface.
 *
 * Any single-letter MSYS drive path is translated (`/c`, `/d`, `/e`, ...);
 * MSYS root paths (`/usr`, `/tmp`), relative paths, UNC paths, and
 * Windows-native paths (`C:\...`, `C:/...`) pass through untouched.
 *
 * Two wrap paths are needed:
 *  - Host-plane tools (read/write/edit/grep/glob/read_image) live in the
 *    global tools layer, so a same-name wrapper registered through this
 *    preset's scope shadows them for every agent joined to the preset.
 *  - The bootstrap `str_replace_editor` registers into THIS preset's own
 *    layer, so a same-name shadow would collide. Its stored definition is
 *    wrapped in place instead: the registry dispatches `tool.execute` off the
 *    stored object at call time.
 */

import { toWindowsPath } from './gitbash-executor.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'msys-path-bridge'

/** Tools registry must exist before wrapping can start. */
export const inject = ['tools']

/** Path-typed argument names for the tools this bridge understands. */
const PATH_FIELDS = {
  read: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  read_image: ['file_path'],
  grep: ['path'],
  glob: ['path'],
  str_replace_editor: ['path'],
}

/**
 * Marker distinguishing an already-wrapped tool from the original. A
 * process-global symbol rather than a module-local one: several preset mounts
 * load their own copy of this plugin, and only the first should wrap a shared
 * host-plane tool definition.
 */
const WRAPPED = Symbol.for('msys-path-bridge-wrapped')

/**
 * Read the dsh-scope tag off the context WITHOUT relying on the imported
 * `scopeOf` symbol: the harness and the preset may resolve different physical
 * copies of dsh-scope (each copy mints its own module-local symbol), so the
 * actual key must be read from the context itself. The tag is an own property
 * of one of the context's prototype ancestors.
 */
function scopeKeyOf(ctx) {
  let depth = 0
  for (let cursor = ctx; cursor !== null && cursor !== undefined && depth < 16; cursor = Object.getPrototypeOf(cursor), depth += 1) {
    for (const symbol of Object.getOwnPropertySymbols(cursor)) {
      if (symbol.description === 'dsh.scope') return cursor[symbol]
    }
  }
  return undefined
}

function normalizeArgs(original, args) {
  const fields = PATH_FIELDS[original.name]
  if (fields === undefined || args === null || typeof args !== 'object') return args
  let changed = false
  const normalized = { ...args }
  for (const field of fields) {
    if (typeof normalized[field] !== 'string') continue
    const converted = toWindowsPath(normalized[field])
    if (converted !== normalized[field]) {
      normalized[field] = converted
      changed = true
    }
  }
  return changed ? normalized : args
}

/**
 * Build a preset-scope shadow of a global tool. `original` is already a
 * registered ToolDefinition: its `parameters` and `output.schema` are
 * compiled JSON Schema, NOT the authoring DSL accepted by `defineTool()`.
 * They are therefore carried over verbatim and only `execute` is replaced.
 */
function wrap(original) {
  const tool = {
    ...original,
    async execute(args, exec) {
      return original.execute(normalizeArgs(original, args), exec)
    },
  }
  tool[WRAPPED] = true
  return tool
}

/**
 * Rewrite the REGISTERED definition's execute body in place. This is the
 * fallback for tools that live in the SAME scope layer as this plugin (the
 * bootstrap `str_replace_editor` registers through this preset's own layer):
 * a same-name shadow registration would throw "already registered", but the
 * registry dispatches `tool.execute` off the stored definition object at call
 * time, so replacing that one property wraps the existing entry.
 */
function wrapInPlace(original) {
  if (original[WRAPPED] === true) return false
  const fields = PATH_FIELDS[original.name]
  if (fields === undefined || typeof original.execute !== 'function') return false
  const execute = original.execute
  original.execute = async (args, exec) => execute(normalizeArgs(original, args), exec)
  original[WRAPPED] = true
  return true
}

export function apply(ctx, config = {}) {
  if (process.platform !== 'win32') return

  const requested = Array.isArray(config.tools) && config.tools.length > 0
    ? config.tools
    : Object.keys(PATH_FIELDS)
  const wanted = new Set(requested.filter(name => name in PATH_FIELDS))
  const wrapped = new Set()
  const scope = scopeKeyOf(ctx)

  const wrapAvailable = () => {
    for (const name of wanted) {
      if (wrapped.has(name)) continue
      const original = ctx.tools.get(name, scope)
      if (original === undefined) continue
      if (original[WRAPPED] === true) {
        wrapped.add(name)
        continue
      }
      if (typeof original.execute !== 'function') {
        wrapped.add(name)
        continue
      }
      try {
        ctx.tools.register(wrap(original))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('already registered')) throw error
        wrapInPlace(original)
      }
      wrapped.add(name)
    }
  }

  // Registration order between rows is concurrent: originals may appear after
  // this plugin applies. Try immediately, retry on a short schedule, and retry
  // on every `tools/change` emission.
  queueMicrotask(wrapAvailable)
  for (const ms of [10, 100, 1000]) {
    setTimeout(() => wrapAvailable(), ms)
  }
  ctx.on('tools/change', () => {
    wrapAvailable()
  })
}
