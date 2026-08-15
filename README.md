# dsh-anchored-standard

[中文说明](./README.zh-CN.md)

An experimental DeepSeek Harness agent preset that bootstraps the first model
request with a Minimal-aligned prompt, the Minimal preset's real tool schema
(`bash` + `str_replace_editor`), and no auto-injected workspace/skill context,
then exposes the complete Standard tool catalog after the first durable tool
call or reply.

This is a community project. It is not an official DeepSeek preset and is not
affiliated with or endorsed by DeepSeek.

## Why

DeepSeek V4 Pro conditions strongly on the API-visible tool catalog. In the
Project2 evaluation, Standard and PTC produced scores of 91 and 92, while the
official Minimal preset produced 99 and 96. Permanently staying on Minimal,
however, gives up the Standard preset's broader tool set.

Anchored Standard separates initial trajectory selection from later tool use:

1. Keep the Minimal complete system prompt.
2. Expose the Minimal preset's REAL tool schemas — persistent `bash` +
   `str_replace_editor`, byte-identical to the official Minimal composition —
   on the first model request. Issue #11 measured this exact schema anchoring
   5/5 runs at the adapter-default maxTokens (256000) with zero `let me`
   first-lines, while every standard-family schema (pwsh/read, pwsh only,
   sandboxed bash/read) fell into standard-like behavior 11/11. The tool
   schema identity is the decisive first-request variable at 256000, so no
   output cap is needed.
3. Strip the auto-injected context on that first request as well — the
   AGENTS.md/CLAUDE.md workspace digest and the available-skills reminder that
   true Minimal never mounts (`suppressedContextSources` in the
   `tool-bootstrap` row). User-initiated skill gestures are not filtered, and
   both injections return unchanged from request #2 on.
4. After the session records its first durable promotion signal — a `tool/call`
   or the first `assistant/message`, whichever comes first — expose all
   Standard tools. Request #1 always sees the bootstrap catalog; request #2
   always sees the full catalog, so a text-only first reply can no longer trap
   the session in bootstrap. (`promoteOn` in the `tool-bootstrap` row selects
   the trigger: `either` default, `tool-call`, or `assistant-message`.)
5. Derive the phase from durable session events so resume and reload preserve it.

The bootstrap catalog is the same on every platform: the Minimal pair
(`bash`/`str_replace_editor`). The preset's shell is the persistent PTY bash
(the sandboxed Standard `bash` row is disabled — both register the `bash` name
into the same layer, and the tools registry rejects duplicates; Windows never
had the sandboxed bash anyway). `pwsh` remains available in the promoted
catalog on Windows.

## Results

Project2 V4.1b, DeepSeek V4 Pro, `reasoningEffort=max`, Windows native:

| Run | Ability | Reasoning blocks | `we` | `let's` | `let me` | Visible replies |
|---|---:|---:|---:|---:|---:|---:|
| r1 | 98 | 193 | 179 | 88 | 1 | 1 |
| r2 | 99 | 162 | 165 | 98 | 0 | 1 |

Both runs emitted exactly two tool-catalog snapshots: the two-tool Minimal
bootstrap, followed by the 25-tool Standard catalog. The result is reproducible
evidence for this task, not a claim of universal improvement across models or
workloads.

Cross-version evidence (issue #11, Windows + official endpoint, first-request
trajectory only): at the adapter-default maxTokens the Minimal tool schema
anchored 5/5 (`We need modify…` first lines, `we` 1.4, `let me` 0.0), while
pwsh/read, pwsh-only, and sandboxed bash/read all produced standard-like
first lines 11/11 — the tool schema, not the output cap, is the decisive
first-request variable at 256000.

Full methodology and aggregate evidence are in
[`xiaobright/modeltest`](https://github.com/xiaobright/modeltest).

## Compatibility

Developed and tested against:

- DeepSeek Harness `0.1.0-rc.5`
- repository commit [`47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
- Node.js 24 on Windows

The persistent shell resolves `shellPath` adaptively: it keeps the
terminal-bash plugin default `/bin/bash` on hosts where that absolute path
exists, and falls back to `bash` (PATH lookup) otherwise — e.g. NixOS, where
bash lives under the Nix store. Hosts that ship `/bin/bash` keep the previous
behavior exactly; the fallback only activates where the default would make
every bash call fail with "PTY shell exited during startup".

On the `0.1.0-rc.5` source checkout, `bootstrapMaxTokens` reaches the actual
first request (the first `request/header` records the cap, `adapterDefaults`
stays empty), because `llm.prepareCall` only materializes a default maxTokens
when the proposed config has none. One prebuilt profile package observed in
issue #11 (CLI launcher reporting `0.1.0-rc.6`) overwrote the proposed cap
with `adapterDefaults.maxTokens`; there the cap is a no-op. The default
composition therefore relies on the Minimal tool schema alone (which anchors
at the adapter default with no cap) and leaves `bootstrapMaxTokens` as an
opt-in for standard-schema bootstraps.

DeepSeek Harness is currently a developer preview and explicitly permits
breaking changes. This preset is a full snapshot of the Standard composition,
so review upstream changes before using it with a newer release.

## Install

Clone this repository, then copy the entire `preset` directory into the user
preset root under the id `anchored-standard`.

PowerShell:

```powershell
$target = Join-Path $env:USERPROFILE '.dsh\.agent-presets\anchored-standard'
if (Test-Path -LiteralPath $target) { throw "Preset already exists: $target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath '.\preset' -Destination $target
```

Linux/macOS:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/anchored-standard"
cp -R preset "$dsh_home/.agent-presets/anchored-standard"
```

Fully restart DeepSeek Harness, create a blank session, and select
**Anchored Standard (experimental)**. Do not switch an active session from a
different preset.

## Verify

Export the session JSONL and inspect `request/header` events. Reproduction
checklist (issue #11 asks for the first two explicitly, because both are the
variables that decide the anchor):

- **First-request `config.maxTokens` value**: with `bootstrapMaxTokens` unset
  (the default), the first header records the adapter default (e.g. 256000
  with `adapterDefaults.maxTokens: true`); with a cap configured it records
  the cap (e.g. 1024 with no maxTokens adapterDefault).
- **First-request tool schema source**: the first header's `tools` array must
  be exactly `["bash", "str_replace_editor"]` — the official Minimal preset's
  real schemas, not Standard's `pwsh`/`read`.
- the first request's messages should contain no AGENTS.md/CLAUDE.md digest and
  no available-skills reminder — only the user message and the minimal persona
  system prompt;
- after the first tool call or the first assistant reply, the next changed
  header should contain the full Standard catalog;
- subsequent requests should keep that full catalog and restore the standard
  context injections.

Run the local zero-dependency tests with:

```sh
npm test
```

## Important behavior

- With the default `promoteOn: either`, the session promotes after its first
  durable `tool/call` OR its first `assistant/message`, whichever comes first —
  request #1 sees the bootstrap catalog and every later request sees the full
  catalog. A text-only first reply therefore still promotes at request #2;
  set `promoteOn: tool-call` to restore the original behavior, where a first
  response that makes no tool call never promotes.
- A failed tool execution still promotes the session because the durable
  `tool/call` already exists.
- The first request's output budget is NOT capped by default: the Minimal tool
  schema anchors at the adapter-default maxTokens, so `bootstrapMaxTokens` is
  opt-in. When set, the first request is capped and the cap is explicitly
  stripped after promotion (the next request's seed proposal carries the
  previous header's maxTokens forward).
- The Minimal pair stays mounted after promotion, so the promoted catalog is
  the Standard catalog plus `bash` (persistent) and `str_replace_editor` —
  and the Standard sandboxed `bash` row is disabled in favor of the persistent
  shell (same tool name, same layer; see Why). The `read`/`write`/`edit` tools
  keep the sandboxed filesystem while `str_replace_editor` uses the preset's
  local fs.
- A missing bootstrap tool degrades to the full catalog with a one-time
  warning instead of failing requests, so a composition drift cannot brick a
  session; invalid `promoteOn` values fail at preset mount instead.
- Promotion decisions are memoized per session for the process lifetime; the
  durable event scan runs once per session per process.
- While a session is unpromoted, the pre-step filter strips messages whose
  `source.kind` is listed in `suppressedContextSources` (default:
  `agent-instructions` and `skill-catalog`, the two automatic injections
  Standard adds over Minimal). Set the list to `[]` to disable the context
  filter; add other `source.kind` values to suppress more. A filter failure
  degrades to keeping every message rather than eating context.
- The tool catalog changes once, so request-prefix cache continuity also changes
  once between the first and second model requests.
- The preset has the same trust level as shell access. Review its files before
  installation.
- The plugin performs no network requests and adds no telemetry.

## Zero-Anchored Standard (experimental)

An extra test mode that does not change the Anchored Standard logic above. It
uses the same Minimal-aligned system prompt, but instead of exposing two tools
on the first request it injects one fixed zero-tool anchor turn:

1. When the user sends their first message, the `anchor-turn` plugin prepends a
   fixed user message — "This round is a test. Tools are not open yet; all
   tools will open next round." — ahead of it.
2. The first real model request carries ZERO tools, so the session's first
   reasoning chain follows the zero-injection "we" trajectory.
3. Once that anchor response is durable, the full Standard catalog is exposed
   and the real message proceeds with all tools.

Anchoring on the first message — not on session creation — keeps the
blank-session preset switcher usable. Subagents always see the full catalog.

Measured behavior (opencode-go, DeepSeek V4 Pro, `reasoningEffort=max`): the
anchor request is stable "we"-style with zero `let me`; the following
tool-bearing requests return to the "The user wants…/Let me" style. This mode
is a comparison point for whether the zero-tool first turn is worth the extra
model call — not a claim that tool rounds stay "we"-style.

Install as a separate preset id:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/zero-anchored-standard"
cp -R zero-anchored-standard "$dsh_home/.agent-presets/zero-anchored-standard"
```

Restart DeepSeek Harness, create a blank session, select **Zero-Anchored
Standard (experimental)**, then send your first message.

## Whoami Standard (experimental)

A usability-oriented variant of the zero-tool anchor idea: the first turn is a
natural self-introduction prompt instead of a fixed test message, and the
user's real first message is deferred to the next turn. Whatever the user types
first, the session warms up exactly one round and everything is ready when the
real message is processed:

1. When the user sends their first message, the `whoami-turn` plugin prepends a
   fixed user message — "你是谁" (who are you) — ahead of it in the `next-turn`
   inbox queue.
2. dsh claims exactly ONE `next-turn` message per turn, so the first model
   request sees only the anchor on an EMPTY tool surface and replies with a
   self-introduction; that reply is the promotion signal.
3. The real message is claimed by the NEXT turn, with the promoted resident
   catalog (shells, `str_replace_editor`, the discovery tools) already
   unlocked — heavier Standard tools are one `dev_tool_search` away.

The anchor text is configurable via the `whoami-turn` row's `text` option
(default "你是谁"). Anchoring on the first message — not session creation —
keeps the blank-session preset switcher usable. With `includeSubagents: true`,
subagents inherit the same flow: their first request is the whoami anchor with
zero tools, and the delegated task runs on the next turn with the resident
catalog. The trade-off is one extra model call per session: the anchor turn is
always taken, even when the first message is urgent.

The preset shares plugin modules with the anchored `preset/` directory via
`../preset/` references, so install that directory as well (see the Install
section above).

Install as a separate preset id:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/whoami-standard"
cp -R whoami-standard "$dsh_home/.agent-presets/whoami-standard"
```

Restart DeepSeek Harness, create a blank session, select **Whoami Standard
(experimental)**, then send your first message — the self-introduction round
runs first, and your message is answered with the full tooling on the next
turn.

## Official ecosystem guidance

DeepSeek currently asks community plugin authors to publish plugins in their own
GitHub projects and add the [`dsh-plugin`](https://github.com/topics/dsh-plugin)
repository topic for discovery. The official repository does not currently
accept external pull requests and does not mandate a community repository
template. See the official
[`CONTRIBUTING.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/CONTRIBUTING.md).

## License

MIT. `preset/agent.cordis.yml` is derived from the DeepSeek Harness Standard
preset; the original DeepSeek copyright and MIT notice are retained in
[`NOTICE`](./NOTICE).
