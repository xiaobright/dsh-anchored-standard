# Prefab Anchored Standard (experimental)

[中文说明](./README.zh-CN.md)

This directory is a self-contained DeepSeek Harness mode. It combines the
Anchored Standard composition with a bundled, successfully rolled session
template and an in-session hydration plugin. Copy this directory alone to
install it; no files from `shared/` or `preset/` are needed at runtime.

The prefab keeps an already established trajectory before the first real task.
Instantiating it makes no model call and incurs no API charge.

## Quick install (recommended)

Give the repository to an AI coding agent and
ask it to follow [`AGENT_INSTALL.md`](./AGENT_INSTALL.md). The agent runs one
command while DSH is closed:

```powershell
node .\prefab\install.mjs --confirm-dsh-closed
```

After `INSTALL READY`, start DSH, open any target workspace, select the
**Prefab Anchored Standard** mode, and create a new session. That session is
prefilled before the selection operation returns; send the benchmark prompt
there. No copying, YAML editing, workspace pre-registration, or manual session
import is required. This command installs the generic template.

The Project2-derived benchmark template is retained for reproduction only and
must be selected explicitly. It defaults to a separate mode id, so it cannot
silently replace the generic installation:

```powershell
node .\prefab\install.mjs --confirm-dsh-closed --template project2
```

This installs **Prefab Anchored Project2** as `prefab-anchored-project2`.

Harness can either mount this preset onto a blank session or create a session
whose header already names it as the default preset. The bundled
`prefab-session-seed.mjs` observes the committed preset selection in the first
case and the first `permission/preset` event in the second, crosses the
non-reentrant `Session.append` boundary with one microtask, and replays the two
model-visible warm-up turns into that same session. It omits thousands of token
stream chunks while retaining lifecycle events, messages, tool calls/results,
and durable tool unlocks, so the WebUI is not flooded. The seeder also aligns
the live Agent's constructor-time turn cursor with the two replayed turns; the
first real prompt therefore opens turn 3 instead of duplicating turn 1.

## Manual installation (advanced)

The one-command installer is preferred. To install manually, copy the directory
while DSH is fully closed:

```powershell
$mode = Join-Path $env:USERPROFILE '.dsh\.agent-presets\prefab-anchored-standard'
if (Test-Path -LiteralPath $mode) { throw "Preset already exists: $mode" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $mode) | Out-Null
Copy-Item -Recurse -LiteralPath '.\prefab' -Destination $mode
```

Linux/macOS:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mode="$dsh_home/.agent-presets/prefab-anchored-standard"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$mode"
cp -R prefab "$mode"
```

The installer defaults to the generic template and `prefab-anchored-standard`.
A custom valid id also works; the in-session seeder derives it from the
installed directory name:

```powershell
node .\prefab\install.mjs --confirm-dsh-closed --preset my-prefab-id
```

The legacy offline instantiator remains available for compatibility. Pass
`--cwd 'E:\path\to\workspace'` to `install.mjs` to create an additional Ready
session. Its `--allowed-tools`, `--rename`, and `--agents-md` options apply only
to that legacy path; `instantiate.mjs --dry-run` remains available for review.

## What is substituted

- The current blank session is hydrated in place; no second session is made.
- The template's source cwd is replaced recursively in reasoning, messages,
  tool calls, and tool results. Forward-slash,
  backslash, JSON-escaped backslash, and Windows case variants are handled.
- The roll-time instruction result is replaced with exact instructions from
  `$DSH_HOME/AGENTS.md`, then the target workspace-root `AGENTS.md`. Equal
  content is injected once; no README, directory, or source scan is performed.
  If neither file exists, a neutral no-additional-rules result is used.
- Failed warm-up instruction-file calls are omitted from the hydrated history.
- The prefab's durable `dev_tool_search` call unlocks `read`, `write`, `edit`,
  `glob`, `grep`, `ask_user_question`, `todo_write`, and `web_search` for the
  real task turn. The bootstrap `bash` and `str_replace_editor` tools plus the
  discovery tools remain resident.

The default generic template contains no Project2 facts, README output, or
directory listing. The opt-in `templates/project2-benchmark.jsonl` preserves
the Project2-derived trajectory used in the reported replication and is not a
general-purpose template. The generic template passed structural and style
validation but was not given a full Project2 re-benchmark before the API price
change. See the
[research contribution](https://github.com/0liveiraaa/DeepseekCotexplorations/tree/main/contributions/xiaobright-v4-tool-surface-dose-response/)
for evidence and limitations.

MCP tools are not bundled into the template: its saved request schemas and
tool calls contain no MCP tool, and no MCP server configuration or credential
is shipped in this directory. MCP tools registered separately for this preset
or profile can still be discovered and unlocked at runtime through
`dev_tool_search`.

## Files

- `agent.cordis.yml`, `preset.yml`, and local plugin files: the installable
  Anchored Standard composition.
- `template.jsonl`: the reviewed, bundled session template.
- `template.jsonl.meta.json`: roll provenance and trajectory summary.
- `templates/project2-benchmark.jsonl`: explicit opt-in benchmark template.
- `prefab-session-seed.mjs`: automatic in-place hydration on mode selection or
  default-preset session creation.
- `install.mjs`: one-command mode installation.
- `instantiate.mjs`: legacy offline workspace-specific session instantiation.
- `roll-runner.mjs` and `roll-prefab.mjs`: optional tooling for producing a
  replacement template.

## Roll a replacement template

This optional step makes real model calls and can incur API charges. It needs a
compatible Harness source checkout, Python 3.14 for multi-frame zstd decoding,
and a configured `headless` DSH profile.

```powershell
$env:DSH_HARNESS_ROOT = 'E:\path\to\deepseek-harness'
node .\prefab\roll-prefab.mjs --cwd 'E:\path\to\workspace' --attempts 6
```

Use a small attempt limit. Every newly rolled template contains raw reasoning,
prompts, tool calls, results, paths, and workspace content. Review it for
credentials and unintended data before replacing the published template.
