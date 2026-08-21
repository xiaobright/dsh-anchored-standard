# dsh-anchored-standard

[English](./README.md)

实验性 DeepSeek Harness agent preset 集合——一个基础模式、两个实时锚定变体和一个预制
会话模式：把模型轨迹锚定在 Minimal 条件上（真实的 Minimal 工具 schema、不注入自动
上下文），会话产生持久信号后晋升到小型 resident 目录，重型 Standard 工具按需解锁。

这是社区项目，并非 DeepSeek 官方 preset，也不代表 DeepSeek 的认可或背书。

欢迎您将插件的使用反馈以Issue或PR的形式进行提交,对于新插件的思路或有用的发现请在[仓库](https://github.com/0liveiraaa/DeepseekCotexplorations)下提交。

## 项目状态（2026-08-17）

随着 DeepSeek 官方 API 与 opencode go 订阅先后涨价，本项目的主动开发已基本停止：
这些 preset 依赖的评测循环（Project2 级别的完整跑分、多轮 roll/探针实验）在当前
价格下已无法负担。仓库维持现状可用，仅接受**维护性更新**（bug 修复与力所能及的
harness 兼容性跟进）。机制结论、剂量实验数据与工具链（context-gate、prefab 管线、
探针套件）仍然有效，且基本与模型无关。维护者写了一份个人感想：
[FAREWELL.md](./FAREWELL.md)；参与项目协作、代码、研究与复现的社区成员见
[致谢名单](./ACKNOWLEDGEMENTS.md)。

社区中反馈在部分场景效果更好的项目：

- [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)——运行时注入器
  + 任务感知的思维模式路由 preset（router-standard 家族）。
- [J-Space Cognition Suite](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6)——
  模型不可知的推理时认知控制层，以 Skill 形式封装。

## 模式总览

| 模式 | 目录 | 首次模型请求 | 锚定机制 | 晋升信号 | 代价 |
|---|---|---|---|---|---|
| Anchored Standard | `preset/` | 2 个工具（Minimal 对） | Minimal 工具 schema | 首次持久 `tool/call` **或** `assistant/message`（`promoteOn: either`） | 无 |
| Zero-Anchored Standard | `zero-anchored-standard/` | 0 个工具 | 一轮固定锚定消息 | 锚定回复（`assistant/message`） | 多一次模型调用 |
| Whoami Standard | `whoami-standard/` | 0 个工具 | 一轮"你是谁"自我介绍 | 自我介绍回复（`assistant/message`） | 多一次模型调用 |
| Prefab Anchored Standard | `prefab/` | 已 roll 的历史种子 | 内置成功轨迹 | 种子中已经晋升 | 实例化不调用模型 |
| Eternal Minimal | `eternal-minimal/` | 永远只有 2 个工具 | 可见目录永不增长；重型工具经 `dshx` bash 网关真实执行 | 无（无阶段概念） | 无 |
| Wire Think-Execute Standard | `wire-think-standard/` | 工具在场 + wire 层 `tool_choice: none` | 思考步路由到兄弟 provider | 按轮：steer 本身 | 每轮 +1 调用、前缀缓存抖动 |
| Combo Anchored | `combo-anchored/` | 每轮用户消息先 0 工具深思 | 思考/执行分离 + 深度闸门 + 深思滴灌三行独立拼装 | 按机制各自生效 | 每轮 +1 调用 |

每个模式目录都自包含，可单独复制安装到任意 id（见[安装](#安装)）。Prefab 在模式选中
后直接原位预填充当前空会话，不需要针对每个工作区导入或离线实例化。

## 术语

- **轨迹（trajectory）**——模型首条思维链的风格。Minimal 条件产生 "We need…" 首行；
  Standard 条件产生 "Let me…"（standard-like）首行。
- **锚定（anchor）**——决定首轮轨迹的首请求条件。Issue #11 分离出三个杠杆：
  工具 schema、输出预算、注入提醒。
- **bootstrap 阶段**——会话的请求 #1：bootstrap 工具对、无自动注入上下文、可选输出封顶。
- **晋升（promotion）**——结束 bootstrap 阶段的持久会话事件。基础模式：首次
  `tool/call` 或 `assistant/message`（先到者为准）；变体：锚定回复。
- **持久（durable）**——已写入会话事件日志。阶段状态从持久事件推导，resume 和
  reload 不丢失。
- **resident 目录**——晋升后的工具集：bootstrap 对 + 发现工具 + 模型已显式解锁的工具。
- **发现工具（discovery tools）**——`dev_tool_search`、`skill_search`、`skill_load`：
  重型 Standard 工具的按需解锁面。
- **物化副本（materialized copy）**——`shared/` 插件在模式目录内的已提交副本，由
  `npm run sync` 生成。

## 工作原理

基础模式的请求生命周期（变体只改首轮，见各自章节）：

```
用户第一条消息
        │
        ▼
┌ 请求 #1 ─ bootstrap 阶段 ─────────────────────────────────┐
│ 工具   : bash + str_replace_editor（Minimal 真实工具对）  │
│ 上下文 : 无 AGENTS.md 摘要、无技能目录提醒                │
│ 预算   : adapter 默认值（`bootstrapMaxTokens` 可选）      │
└────────────────────────────────────────────────────────────┘
        │ 首次持久 tool/call 或 assistant/message
        ▼ 晋升——从持久事件推导，resume 安全
┌ 请求 #2 起 ─ resident 阶段 ───────────────────────────────┐
│ 工具   : bootstrap 对 + 发现工具 + 已解锁工具             │
│ 上下文 : 恢复常规注入                                     │
│ 预算   : adapter 默认值（封顶在晋升时剥离）               │
└────────────────────────────────────────────────────────────┘
```

决定首轮轨迹的三个杠杆（issue #11）：

1. **工具 schema**——adapter 默认 maxTokens（256000）下的决定变量。真实 Minimal 对
   5/5 锚定；所有 standard 系 schema 11/11 落入 standard-like。
2. **输出预算**——首请求 1024 封顶同样能锚定轨迹（26/32），且独立于工具描述。
   基础模式不设此杠杆（`bootstrapMaxTokens` 为 opt-in）。
3. **注入提醒**——AGENTS.md/CLAUDE.md 摘要和可用技能提醒。技能目录在场时锚定完全
   无法复现（0/9）；bootstrap 期间两者都被剥离。

## 为什么这样做

DeepSeek V4 Pro 会强烈依赖 API 中可见的工具目录选择执行轨迹。在 Project2 评测中，
Standard 和 PTC 分别得到 91、92 分，官方 Minimal 得到 99、96 分；但如果全程停留在
Minimal，又会失去 Standard 的大部分工具。

Anchored Standard 把"首次轨迹选择"和"后续完整工具能力"拆开：

1. 保持 Minimal 的完整 system prompt；
2. 首次模型请求暴露 Minimal 预设的**真实工具 schema**——持久 `bash` +
   `str_replace_editor`，与官方 Minimal 组装逐字节一致（上述杠杆 1）；
3. 首次请求同时压制**所有**自动注入的上下文——在 harness 的两条统一注入路径上拦截，
   而不是按来源点名（置首的 `context-gate` 行；杠杆 3）。会话未晋升期间：装配的动态
   runtime-context 贡献被清空（覆盖整个 `SystemPrompt.context()` 家族：沙箱/审批策略
   快照和任何第三方上下文提供者），pre-step 瀑布只保留本轮 CLAIMED 的消息批次加一个
   很小的 kind 白名单（用户主动的技能手势放行；技能目录、AGENTS.md 摘要、time/tmux
   上下文、hooks、未知第三方注入默认全剥）。晋升后门打开，循环自身的快照投影会在
   下一个请求恰好差分注入一条全新 runtime-context 消息——首轮极简、二轮注入。
   `compaction/end` 边界同样会重新关门；
4. 会话出现首次持久晋升信号（`tool/call` 或首次 `assistant/message`，先到者为准）
   后晋升到 **resident 目录**：bootstrap 对 + 发现工具 + 模型已通过
   `dev_tool_search` 显式解锁的工具。晋升时一次性倒出完整 Standard 目录会把轨迹
   拉回 standard-like（晋升后回退问题），因此重型工具——`web_search`、`subagent`、
   `workflow` 等——保持一次 `dev_tool_search` 即可取用。请求 #1 恒为 bootstrap
   目录，请求 #2 恒为 resident 目录，纯文字首答不再把会话困死在 bootstrap
   （`tool-bootstrap` 行的 `promoteOn` 可选 `either` 默认 / `tool-call` /
   `assistant-message`）；
5. 从持久 session event 推导阶段，resume 和 reload 不会丢失状态。

所有平台的 bootstrap 目录相同：Minimal 工具对（`bash`/`str_replace_editor`）。preset
的 shell 是持久 PTY bash（Standard 的沙箱 `bash` 行被禁用——两者在同一个层里注册
同名 `bash`，工具注册表拒绝重复；Windows 本来就没有沙箱 bash）。Windows 上晋升后的
目录仍包含 `pwsh`。

## 实测结果

Anchored 系列在 Project2 上完成了三轮 V4 Pro 验证，分数为 98、99、99。出处说明
（issue #60）：那三轮早于当前实现——当时用的是 Minimal 系统提示 + 首请求
`pwsh` + `read` 工具面，晋升后放开到完整 25 工具 Standard 目录；精确的 Minimal 对
（持久 `bash` + `str_replace_editor`）加小 resident 目录是之后才引入的。默认内置的
通用 prefab 已移除 Project2 专属 warm-up 事实，但在 API 涨价前没有重新跑完整评测，
因此不能把上述分数直接归因于通用模板。

独立复现情况：轨迹锚定被强复现，但能力差在小样本下未决——见
[#65](https://github.com/xiaobright/dsh-anchored-standard/issues/65)
（锚定按预设 9/9 完全分离；anchored−standard +3.3，95% CI [−2.6, +9.3]）与
[#51](https://github.com/xiaobright/dsh-anchored-standard/issues/51)
（多环境 11 轮，Ability 85–90，未复现 98/99）。上述分数请视为我们的原始观测，
而非已确立的效应量。

研究记录统一放在配套的探索仓库
[DeepseekCotexplorations](https://github.com/0liveiraaa/DeepseekCotexplorations)
（数据与方法；本仓库只放代码）：

- [工具面剂量 + Project2 复现](https://github.com/0liveiraaa/DeepseekCotexplorations/tree/main/contributions/xiaobright-v4-tool-surface-dose-response/)——方法、
  各轮口径、工具面实验和限制。
- [锚定质量块量化 + 单请求探针方法论](https://github.com/0liveiraaa/DeepseekCotexplorations/tree/main/contributions/xiaobright-v4-anchor-mass-probe/)——prefab
  模板质量模型与涨价后的低成本评估循环。

开发过程记录（做了什么、为什么、踩坑清单）留在本仓库的
[`HANDOFF.md`](./HANDOFF.md) 与 [`HANDOFF-2.md`](./HANDOFF-2.md)。

## 配置参考

所有开关都是各模式 `agent.cordis.yml` 中的行。未知键在 preset 挂载时报错。

`context-gate`（在 `preset/`、`zero-anchored-standard/`、`whoami-standard/` 中均挂在
FIRST 行——瀑布注册顺序使门成为最外层变换；插件本体在 `shared/context-gate.mjs`，
可供任何其他需要统一注入控制的组合单独复用）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `promoteOn` | `either` | 晋升触发：`either` / `tool-call` / `assistant-message`（两个变体用 `assistant-message`）。 |
| `includeSubagents` | `false` | 子 agent 同样过门（基础模式与 whoami 设 `true`；与 bootstrap 行保持一致）。 |
| `enabled` | `true` | `false` 关闭两条拦截路径（不动行集合即可做 A/B）。 |
| `allowKinds` | `[skill-invocation]` | claimed 批次之外放行的 `source.kind`；`[]` 表示只保留 claimed 批次。 |

注入控制的分工：会话相位级抑制（一切以晋升边界为键）归 `context-gate`。
两个有文档说明的例外保留各自的枚举式 `suppressedContextSources`，因为门的相位机
覆盖不了它们的作用域：`think-phase`/`wire-think` 的 think-step 级剥离（按步而非
按会话相位），以及 `eternal-minimal` 的永驻逐请求剥离（没有晋升边界；且已冻结在
其实测记录所用的配置下）。

`tool-bootstrap`（位于 `preset/agent.cordis.yml`；紧跟在 `context-gate` 之后挂载）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `bootstrapTools` | `[bash, str_replace_editor]` | 请求 #1 可见的工具。 |
| `promoteOn` | `either` | 晋升触发：`either` / `tool-call` / `assistant-message`。 |
| `bootstrapMaxTokens` | 未设 | 请求 #1 的可选输出封顶；晋升后剥离。 |
| `includeSubagents` | `false` | 子 agent 同样走 bootstrap 阶段（基础模式设 `true`）。 |
| `compactionTools` | `[]` | compaction 边界到再晋升之间可用的额外工具。 |

`zero-tool-bootstrap`（位于 `zero-anchored-standard/` 和 `whoami-standard/`）：
`compactionTools` 语义相同（晋升恒为首次 `assistant/message`），另有
`includeSubagents`——子 agent 是否也走锚定阶段（`whoami-standard` 设 `true`，
`zero-anchored-standard` 为 `false`）。上下文抑制不在此行——两个变体均在首行挂载
`context-gate`（`promoteOn: assistant-message`）；原来的 `suppressedContextSources`
键现在会在挂载时报错。

`anchor-turn`（两个变体）：`text`——合成的首条用户消息（zero-anchored 默认
"This round is a test. Tools are not open yet; all tools will open next round."，
whoami 为"你是谁"）；`includeSubagents`——子 agent 是否也走锚定轮。


`eternal-minimal`（位于 `eternal-minimal/`；该行必须保持 FIRST）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `guide` | `true` | 在系统提示追加简短 `dshx` 能力指南；`false` 保持 persona 字节纯净。 |
| `gateway` | `true` | 拦截 `dshx` shell 命令并真实执行对应工具；`false` 只留裸 Minimal 对。 |
| `gatewayCommand` | `dshx` | 拦截命令词。 |
| `maxGatewayChars` | `12000` | 单次网关结果负载上限。 |
| `suppressedContextSources` | `[agent-instructions, skill-catalog]` | 每个请求都剥离（没有晋升边界；有意保留枚举实现，见上方分工说明）。 |


`cot-drip`（位于 `combo-anchored/`）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `every` | `4` | 每第 N 个工具结果附带一次深思节拍；`0` 关闭滴灌。 |
| `maxPerTurn` | `1` | 每轮节拍上限。 |
| `text` | 内置节拍 | 提醒文本（一句 "We …" 重述剩余目标）。 |
| `includeSubagents` | `false` | 子 agent 的调用是否也滴灌。 |

`toolchoice-adapter`（位于 `wire-think-standard/`；该行必须保持首个本地行）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `provider` | `deepseek-wire-think` | 兄弟路由 id；重复注册触发 DUPLICATE_ADAPTER（被捕获并降级）。 |
| `toolChoice` | `none` | 工具定义在场时发送的 wire `tool_choice`。 |
| `baseURL` / `apiKeyEnv` | settings/env | 行配置优先，其次 `llm-deepseek` settings 段，最后 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`。 |
| `logprobs` | `false` | opt-in 研究钩子：请求 token logprobs 并记录每请求均值摘要。 |

`wire-think`（位于 `wire-think-standard/`）：`mode` / `suppressedContextSources` /
`includeSubagents` / `steerText` 语义同 `think-phase`，另有 `provider`（须与
`toolchoice-adapter` 行一致）和 `defaultProvider`（执行步还原的路由，默认
`deepseek-official`）。

`instruction-hint`（所有模式）：`promoteOn` 与各模式晋升语义对齐（基础模式
`either`，变体 `assistant-message`）——那条一次性的"存在指令文件，先读再动手"
提示等晋升后才注入。

## 仓库布局

```
preset/                  Anchored Standard——基础模式
zero-anchored-standard/  变体：固定零工具锚定轮
whoami-standard/         变体："你是谁"锚定轮，子 agent 继承
eternal-minimal/         变体：Minimal 对永恒 + dshx bash 网关
wire-think-standard/     变体：wire 层条件（工具定义在场 + 调用禁止）
combo-anchored/          组合包：思考分离 + 闸门 + 滴灌三行拼装
shared/                  多模式共用插件的唯一源
scripts/sync-modes.mjs   把 shared/ 插件物化到每个模式目录
test/                    零依赖测试套件（npm test）
verify/                  一次性 headless 验证 runner
prefab/                  Prefab Anchored Standard + 内置会话模板
```

`prefab/` 默认提供通用模板，并把 Project2 专用模板保留为显式 opt-in。二者都包含真实
模型推理，使用前请阅读该模式的[安装说明](./prefab/README.md)。

不变量，由 `npm run check` 强制：

- 每个模式目录自包含：单独复制即可安装；`agent.cordis.yml` 的行只能引用
  `./本地.mjs`，绝不允许 `../`。
- 多模式共用插件只在 `shared/` 存一份；模式目录里的副本是生成的。编辑 `shared/`、
  运行 `npm run sync`、两者一起提交——绝不直接改物化副本。
- `context-gate` 行保持 `preset/agent.cordis.yml` 的 FIRST 行（门必须先于所有注入
  插件注册），`tool-bootstrap` 紧随其后。`zero-anchored-standard/` 与
  `whoami-standard/` 中的 `context-gate` 行同样必须保持 FIRST 行。

本仓库刻意不提供 AGENTS.md/CLAUDE.md：这套 preset 的机制核心就是干净的首请求——
恰恰要从首请求里剥离这些指令文件摘要（issue #6：注入在场时 0/9 锚定）。仓库里放
一个只会喂给后续轮次，与被文档描述的机制自相矛盾。助手需要的一切都在本 README 中。

## 兼容范围

开发和验证版本：

- DeepSeek Harness `0.1.0-rc.5`
- 仓库提交 [`47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
- Windows / Node.js 24

持久 shell 的 `shellPath` 按环境自适应：`/bin/bash` 存在的传统主机保持
terminal-bash 插件的默认行为不变；仅当该绝对路径不存在（如 NixOS，bash
位于 Nix store 中）时才回退为 `bash`（PATH 查找）。自带 `/bin/bash` 的主机
行为与之前完全一致，回退分支只在默认值会导致每次 bash 调用都报
"PTY shell exited during startup" 的环境上生效。

在 `0.1.0-rc.5` 源码检出上，`bootstrapMaxTokens` 能到达实际首请求（首份
`request/header` 记录封顶值，`adapterDefaults` 为空），因为 `llm.prepareCall`
只在提案 config 没有 maxTokens 时才物化默认值。issue #11 观察到的一个预构建 profile
包（CLI launcher 报告 `0.1.0-rc.6`）会用 `adapterDefaults.maxTokens` 覆盖提案封顶，
在那里该封顶不生效。因此默认组装只依赖 Minimal 工具 schema（256000 下无需封顶即可
锚定），`bootstrapMaxTokens` 作为 standard 系 bootstrap 的 opt-in 保留。

DeepSeek Harness 目前仍是开发者预览版，官方明确说明未来会有破坏性变更。本 preset 是
Standard 组装的完整快照；升级 Harness 后，应先对照上游改动再继续使用。

## 安装

Prefab 模式推荐由 AI agent 一键安装：把本仓库交给编程 agent，让它执行
[安装 Agent 操作契约](./prefab/AGENT_INSTALL.md)。Agent 报告 `INSTALL READY` 后，
启动 DSH，在目标工作区选择 **Prefab Anchored Standard** 模式并新建会话，然后直接
发送真实任务提示词。该命令默认安装通用模板；Project2 评测模板必须显式传入
`--template project2`，并默认使用独立 preset id。

克隆本仓库，将整个 `preset` 目录复制到用户 preset 根目录，并将目标目录命名为
`anchored-standard`。仓库中的每个模式目录都是自包含的：`zero-anchored-standard/`、
`whoami-standard/`、`prefab/`、`eternal-minimal/`、`wire-think-standard/`、
`combo-anchored/` 变体以同样方式安装，可只装其中一个、多个或全部，不依赖
其他目录（见下文各自的章节）。`prefab/` 会为手动切换到该模式的会话，以及创建时
已将其作为默认 preset 的会话自动预填充内置模板；
按 [`prefab/README.md`](./prefab/README.md) 操作。

PowerShell：

```powershell
$target = Join-Path $env:USERPROFILE '.dsh\.agent-presets\anchored-standard'
if (Test-Path -LiteralPath $target) { throw "Preset already exists: $target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath '.\preset' -Destination $target
```

Linux/macOS：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/anchored-standard"
cp -R preset "$dsh_home/.agent-presets/anchored-standard"
```

完整重启 DeepSeek Harness，新建空 session，选择 **Anchored Standard (experimental)**。
不要在已经产生内容的会话中途切换 preset。

## 验证加载

导出 session JSONL，检查 `request/header`。复现清单（issue #11 明确要求前两项，
因为这两项正是决定锚定的变量）：

- **首请求 `config.maxTokens` 值**：未配置 `bootstrapMaxTokens`（默认）时，首份
  header 记录 adapter 默认值（如 256000 且 `adapterDefaults.maxTokens: true`）；
  配置封顶时记录封顶值（如 1024 且无 maxTokens adapterDefault）。
- **首请求工具 schema 来源**：首份 header 的 `tools` 必须恰好是
  `["bash", "str_replace_editor"]`——官方 Minimal 预设的真实 schema，而不是
  Standard 的 `pwsh`/`read`。
- 第一次请求的消息中不应包含 AGENTS.md/CLAUDE.md 摘要或可用技能目录提醒——只有
  用户消息与 Minimal persona 系统提示；
- 首次工具调用或首次助手回复后，下一份变更 header 应包含晋升后的 resident 目录：
  bootstrap 对 + `dev_tool_search`/`skill_search`/`skill_load` + 模型已解锁的工具；
- 此后的请求应保持该 resident 集（只通过显式 `dev_tool_search` 解锁增长），并恢复
  常规上下文注入。

本仓库的零依赖测试：

```sh
npm test
```

## 重要行为

- 默认 `promoteOn: either`：会话在首次持久 `tool/call` **或** 首次 `assistant/message`
  （先到者为准）后晋升——请求 #1 见 bootstrap 目录，之后所有请求见 resident 目录；
  纯文字首答也会在请求 #2 晋升。改为 `promoteOn: tool-call` 可恢复原行为（首答不调
  工具则永不晋升）；
- 工具执行即使失败，只要 `tool/call` 已持久化，下一步仍会晋升；
- 首请求输出预算默认**不**封顶：Minimal 工具 schema 在 adapter 默认 maxTokens 下
  即可锚定，`bootstrapMaxTokens` 是 opt-in。设置后首请求被封顶，晋升后显式去掉
  封顶（下一次请求的 seed proposal 会继承上一份 header 的 maxTokens）；
- 晋升目录是 **resident 集**——bootstrap 对 + 发现工具 + 模型经 `dev_tool_search`
  解锁的一切——而非完整 Standard 倒出。Standard 的沙箱 `bash` 行保持禁用，改用
  持久 shell（同名、同层，见"为什么这样做"）。`read`/`write`/`edit` 解锁后继续使用
  沙箱文件系统，`str_replace_editor` 使用 preset 自己的本地 fs；
- bootstrap 工具缺失时降级为完整目录并一次性告警，不再让请求失败，组合漂移不会锁死
  会话；非法的 `promoteOn` 值会在 preset 挂载时报错；
- 晋升判定按会话在进程内记忆化，持久事件扫描每会话每进程只执行一次。
- 会话未晋升期间，`context-gate` 插件关闭两条统一注入路径：装配的 runtime-context
  贡献被清空（整个 `SystemPrompt.context()` 家族，无需按来源枚举），pre-step 瀑布
  只保留 claimed 批次加 `allowKinds` 条目。晋升时循环的快照投影恰好差分注入一条全新
  runtime-context 消息；门自身出错时降级为保留全部消息，绝不吞掉上下文。
- 工具目录在晋升时变化一次，之后每次 `dev_tool_search` 解锁新工具再变化；前缀缓存
  连续性在这些点上断开；
- preset 与 shell 访问具有相同信任等级，安装前应自行审阅文件；
- 插件不会发起网络请求，也不增加遥测。

## Zero-Anchored Standard（实验）

这是不改变上面 Anchored Standard 逻辑的额外测试模式。它沿用同一套 Minimal
对齐的 system prompt，但首轮不再暴露两个工具，而是先注入一轮固定的零工具锚定
对话：

1. 用户发出第一条消息时，`anchor-turn` 插件会把固定消息——"This round is a
   test. Tools are not open yet; all tools will open next round."——插到它前面；
2. 第一个真实模型请求携带 **0 个工具**，首条思维链因此走零注入的 "we" 轨迹；
3. 锚定回复落库后开放 resident 目录，真实消息带着它继续。

锚定发生在第一条消息到达时而不是会话创建时，因此新建会话仍然可以先切换模式；
子 agent 始终看到 resident 目录。

实测行为（opencode-go、DeepSeek V4 Pro、`reasoningEffort=max`）：锚定请求稳定
为 "we" 风格且 `let me` 为 0；后续带工具请求会回到 "The user wants…/Let me"
风格。因此该模式用于对比"零工具首轮是否值得多一次模型调用"，并不承诺工具轮次
保持 "we" 风格。

以独立 preset id 安装：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/zero-anchored-standard"
cp -R zero-anchored-standard "$dsh_home/.agent-presets/zero-anchored-standard"
```

重启 DeepSeek Harness，新建空白会话，选择 **Zero-Anchored Standard
(experimental)**，然后发送第一条消息。

## Whoami Standard（实验）

"零工具锚定"思路的易用性变体：首轮不是固定测试语，而是一句自然的自我介绍
提示（"你是谁"），用户的第一条真实消息自动推迟到下一轮。无论你第一条发什么，
会话都会先热身一轮，等你真实的消息进来时一切就绪：

1. 用户发出第一条消息时，`anchor-turn` 插件把固定消息——"你是谁"——prepend 到
   `next-turn` 收件队列、排在真实消息前面；
2. dsh 每轮只消费一条 `next-turn` 消息，因此第一个模型请求只看到锚定消息、
   携带 **0 个工具**，模型回复自我介绍，该回复即晋升信号；
3. 下一轮才轮到真实消息，此时晋升后的 resident 目录（shell、str_replace_editor、
   发现类工具）已解锁，重型 Standard 工具一次 `dev_tool_search` 即可取用。

锚定文本可通过 `anchor-turn` 行的 `text` 配置（默认"你是谁"）。锚定发生在第一条
消息到达时而非会话创建时，新建会话仍可先切换模式。

### 全功能子 agent（full-powered subagents）

Whoami Standard 默认在 `zero-tool-bootstrap` 与 `anchor-turn` 两行都设置了
`includeSubagents: true`，因此会话派生的子 agent 与顶层会话继承同一套锚定流程：

1. 新派生子 agent 的首个模型请求只看到"你是谁"锚定消息，工具目录为空；
2. 子 agent 的自我介绍回复即晋升信号；
3. 委托任务在下一轮执行，此时已带着晋升后的 resident 目录（shell、
   str_replace_editor、发现类工具）。

将两行的 `includeSubagents` 设为 `false` 可恢复普通行为（子 agent 直接以
resident 目录起步）。每个子 agent 的锚定轮固定多一次模型调用——重委托的
会话按子 agent 数量累计。

`zero-anchored-standard` 默认保持子 agent 直接起步；若要在那里启用同样的
流程，需在其 `zero-tool-bootstrap` 与 `anchor-turn` 行设置
`includeSubagents: true`（其锚定文本仍是固定测试语）。

本模式自身的代价是每个会话固定多一次模型调用——即使第一条消息很紧急也会先跑
自我介绍轮。

该目录自包含，可单独安装，也可与其他模式任意组合安装。

以独立 preset id 安装：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/whoami-standard"
cp -R whoami-standard "$dsh_home/.agent-presets/whoami-standard"
```

重启 DeepSeek Harness，新建空白会话，选择 **Whoami Standard (experimental)**，
然后发送第一条消息——自我介绍轮先跑，你的消息在下一轮带着完整工具被回答。


## Eternal Minimal（实验）

"让模型以为从未离开极简模式"：模型可见目录整个会话恒等于 Minimal 对
（`bash` + `str_replace_editor`）——没有锚定轮、没有晋升、没有发现工具、
目录永不增长——同时完整 Standard 工具集保持注册，并通过 `dshx` bash 网关
**真实执行**：

```
dshx list                           # 列出所有网关工具
dshx web_search '{"query": "..."}'  # 真实执行 web_search
dshx read_image '{"path": "..."}'   # 真实执行 read_image
```

1. **永恒对**：`system-prompt/assemble` 在每个请求上只保留 shell +
   `str_replace_editor`（思考步、compaction 后、子 agent——一切请求），
   自动注入上下文全程剥离（没有按晋升边界抑制的概念）。
2. **网关**：`tools/pre-execute` 监听器拦截以 `dshx` 开头的 bash 命令，经
   `ctx.tools.execute()`（完整注册表管线——策略、guard、执行、渲染）分发，
   并把渲染输出作为命令结果返回。deny 通道是派发前替换结果的唯一受支持
   手段，因此网关负载带错误标记——每条负载都明确说明工具已执行、输出在后，
   模型将其读作输出。真实工具确实跑了：用户看到真实效果（文件、搜索、
   子 agent），与按名调用无异。
3. **指南**：系统提示追加简短 `dshx` 能力指南（`guide: false` 可得字节纯净
   的 Minimal persona），让模型在不增加第三个可见工具的前提下知道网关存在。

网关拒绝分发 shell/`str_replace_editor` 本身（"请直接调用"），这也使递归不可能
发生。未知工具、JSON 格式错误、工具失败都以可读负载返回。`gateway: false`
可得到无拦截的纯双工具会话。

以独立 preset id 安装：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/eternal-minimal"
cp -R eternal-minimal "$dsh_home/.agent-presets/eternal-minimal"
```

重启 DeepSeek Harness，新建空白会话，选择 **Eternal Minimal (experimental)**，
照常工作——模型编写 shell 命令，`dshx …` 行真实运行重型 Standard 工具。


## Wire Think-Execute Standard（实验）

wire 层模式：每轮用户消息先跑一个思考步——请求中工具定义**在场**、wire 层
禁止调用（`tool_choice: "none"`）——然后一条 steering 通知在官方 provider
上打开执行阶段，带着 resident 目录。

`tool_choice` 不在 harness `GenerateOptions` 词汇内（官方 deepseek
adapter 明确标注为 MVP cut），因此需要走受支持的 wire 接缝：

1. **兄弟路由**：`toolchoice-adapter.mjs`（第 1 行）注册一个零依赖的
   DeepSeek chat-completions adapter，挂在自己的 provider id
   （`deepseek-wire-think`）下，在工具定义在场时向 wire 放
   `tool_choice: "none"`。官方 `DeepSeekAdapter` 无法被包装（wire body
   在私有 generator 里构建），因此该文件 vendor 了官方
   serialize/SSE/translate 管线的最小协议忠实子集——相同的 assistant
   消息细节（`content: ""` 永不为 null、`reasoning_content` 只在
   tool-call 轮回放、工具结果转 `role: "tool"` 并带 `(no output)` 兜底）
   和相同的 usage/finish 翻译。连接事实的解析顺序是行配置 >
   `llm-deepseek` settings 段 > 环境变量，与官方行完全一致，同一个
   `DEEPSEEK_API_KEY` 同时服务两条路由。
2. **按步路由**：`wire-think.mjs` 保持思考步的组装目录**原样不动**（这
   正是被复现的条件），只在 `agent/request` 瀑布里换 provider——冻结的
   loop 内建请求与日志可重建性不变。执行步（以及所有子 agent）被路由
   回捕获的原始 provider，即使折叠的会话 header 把思考路由播种进了
   下一步的种子配置。
3. **Steer + resident**：`agent/turn-stopping` 每轮恰好 steer 一次
   （从持久 `steering/message` 事件重建，resume 安全），执行步看到晋升
   的 RESIDENT 集。

降级阶梯：兄弟路由未注册（行被删、或另一个 preset 已挂载同一 id——
DUPLICATE_ADAPTER 被捕获并告警）时，思考步退回零工具条件——组合
错误绝不会弄坏会话。`mode: first-turn` 把路由（及其代价）限制在会话的
首个用户轮。

采用前需要知道的代价：思考/执行交替每轮两次切换请求前缀中的 tools
块，DeepSeek 前缀缓存从首个变化 token 起失效（provider id 本身对后端
缓存不可见；发散的是 tools 块）。每次切换追加一条 `request/header`
变更事件。adapter 行设 `logprobs: true` 可开启 opt-in 研究钩子——
adapter 请求 token logprobs 并记录每请求均值摘要（harness StreamChunk
词汇没有 logprob 数据的表面，插件今天能做的只有记日志；这个日志流正是
离线轨迹分析要消费的东西）。

以独立 preset id 安装：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/wire-think-standard"
cp -R wire-think-standard "$dsh_home/.agent-presets/wire-think-standard"
```

## Combo Anchored（实验）——插件组合包

"一切皆插件"的展示位：**三个正交锚定机制**以独立行拼装，各自带开关，
改 `agent.cordis.yml` 里的一行即可删除或重调。它们在轮次的不同时刻攻击
工具前的深思塌缩：

| 行 | 机制 | 负责的时刻 |
|---|---|---|
| `think-phase` | 零工具思考步 + steering 通知 | 轮次开场 |
| `deliberation-gate` | 深度闸门拦截浅轮次的首工具调用 | 首个动作 |
| `cot-drip` | 每第 N 个工具结果后一条 "We …" 节拍（`tools/post-execute` additionalContexts——不拦截、不报错） | 漫长的中段 |

`mode: every-turn` 下思考步每轮开场，闸门兜住绕过它的路径（steering
续步、恢复的会话、直奔工具的跟进），滴灌在长工具回路中维持深思。默认值
刻意温和（`minChars: 400`、`every: 4`、每轮一拍），按负载调整。把
`think-phase` 行换成 `wire-think` + `toolchoice-adapter` 可把开场升级为
wire 层条件（见上），代价是兄弟路由及其前缀缓存代价。

探索过并否决的方向：纯 Code Mode 呈现（`presentAs('code')` 把目录折叠为
单个 `run_code` 工具）——单工具表面在兄弟项目的评测中明显劣于双工具
条件；文本诡称有工具与幽灵 tool_call 历史——实践中都不是可靠锚。

## 官方生态要求

DeepSeek 当前建议社区作者把插件放在自己的 GitHub 项目中，并为仓库添加
[`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 方便发现。官方仓库目前不接受
外部 PR，也没有强制社区插件仓库模板。原文见官方
[`CONTRIBUTING.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/CONTRIBUTING.zh.md)。

## 许可证

MIT。`preset/agent.cordis.yml` 基于 DeepSeek Harness Standard preset 修改，原始 DeepSeek
版权和 MIT 许可声明保留在 [`NOTICE`](./NOTICE) 中。
