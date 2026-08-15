# dsh-anchored-standard

[English](./README.md)

这是一个实验性的 DeepSeek Harness agent preset：第一次模型请求使用与 Minimal 对齐的
完整 system prompt、Minimal 预设的真实工具 schema（`bash` + `str_replace_editor`），
并且不注入工作区/技能上下文；会话记录首次持久晋升信号（`tool/call` 或首次
`assistant/message`，先到者为准）后，开放 Standard 的完整工具目录并恢复常规上下文注入。

这是社区项目，并非 DeepSeek 官方 preset，也不代表 DeepSeek 的认可或背书。

## 为什么这样做

DeepSeek V4 Pro 会强烈依赖 API 中可见的工具目录选择执行轨迹。在 Project2 评测中，
Standard 和 PTC 分别得到 91、92 分，官方 Minimal 得到 99、96 分；但如果全程停留在
Minimal，又会失去 Standard 的大部分工具。

Anchored Standard 把“首次轨迹选择”和“后续完整工具能力”拆开：

1. 保持 Minimal 的完整 system prompt；
2. 首次模型请求暴露 Minimal 预设的**真实工具 schema**——持久 `bash` +
   `str_replace_editor`，与官方 Minimal 组装逐字节一致。Issue #11 实测：在 adapter
   默认 maxTokens（256000）下该 schema 5/5 锚定（首行 `We need…`，`let me` 为 0），
   而所有 standard 系 schema（pwsh/read、仅 pwsh、沙箱 bash/read）11/11 落入
   standard-like——256000 下工具 schema 身份是首轮锚定的决定变量，因此无需输出
   封顶；
3. 首次请求同时剥离自动注入的上下文——AGENTS.md/CLAUDE.md 工作区摘要和可用技能
   目录提醒，真正的 Minimal 根本不挂载这两个插件（`tool-bootstrap` 行的
   `suppressedContextSources`）。用户主动的技能手势不被过滤，且两者从请求 #2 起
   原样恢复；
4. 会话出现首次持久晋升信号（`tool/call` 或首次 `assistant/message`，先到者为准）
   后开放全部 Standard 工具——请求 #1 恒为 bootstrap 目录，请求 #2 起恒为完整目录，
   纯文字首答不再把会话困死在 bootstrap（`tool-bootstrap` 行的 `promoteOn` 可选
   `either` 默认 / `tool-call` / `assistant-message`）；
5. 从持久 session event 推导阶段，resume 和 reload 不会丢失状态。

所有平台的 bootstrap 目录相同：Minimal 工具对（`bash`/`str_replace_editor`）。preset
的 shell 是持久 PTY bash（Standard 的沙箱 `bash` 行被禁用——两者在同一个层里注册
同名 `bash`，工具注册表拒绝重复；Windows 本来就没有沙箱 bash）。Windows 上晋升后的
目录仍包含 `pwsh`。

## 实测结果

Project2 V4.1b、DeepSeek V4 Pro、`reasoningEffort=max`、Windows 原生环境：

| 运行 | Ability | reasoning 块 | `we` | `let's` | `let me` | 可见回复 |
|---|---:|---:|---:|---:|---:|---:|
| r1 | 98 | 193 | 179 | 88 | 1 | 1 |
| r2 | 99 | 162 | 165 | 98 | 0 | 1 |

两轮都只出现两份工具目录快照：首次为 Minimal 两工具，随后为 25 项 Standard 工具。
这证明该方案在本题同配置下可以复现，不代表它对所有模型和任务都普遍增益。

跨版本证据（issue #11，Windows + 官方端点，只统计首请求轨迹）：adapter 默认
maxTokens 下，Minimal 工具 schema 5/5 锚定（首行 `We need modify…`，`we` 1.4，
`let me` 0.0）；而 pwsh/read、仅 pwsh、沙箱 bash/read 全部 11/11 出现 standard-like
首行——256000 下决定首轮锚定的是工具 schema，不是输出封顶。

完整方法和聚合证据见
[`xiaobright/modeltest`](https://github.com/xiaobright/modeltest)。

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

克隆本仓库，将整个 `preset` 目录复制到用户 preset 根目录，并将目标目录命名为
`anchored-standard`。

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
- 首次工具调用或首次助手回复后，下一份变更 header 应包含完整 Standard 目录；
- 此后的请求应保持完整目录，并恢复常规上下文注入。

本仓库的零依赖测试：

```sh
npm test
```

## 重要行为

- 默认 `promoteOn: either`：会话在首次持久 `tool/call` **或** 首次 `assistant/message`
  （先到者为准）后晋升——请求 #1 见 bootstrap 目录，之后所有请求见完整目录；纯文字
  首答也会在请求 #2 晋升。改为 `promoteOn: tool-call` 可恢复原行为（首答不调工具则
  永不晋升）；
- 工具执行即使失败，只要 `tool/call` 已持久化，下一步仍会晋升；
- 首请求输出预算默认**不**封顶：Minimal 工具 schema 在 adapter 默认 maxTokens 下
  即可锚定，`bootstrapMaxTokens` 是 opt-in。设置后首请求被封顶，晋升后显式去掉
  封顶（下一次请求的 seed proposal 会继承上一份 header 的 maxTokens）；
- Minimal 工具对在晋升后仍然挂载，因此晋升目录 = Standard 目录 + `bash`（持久）
  和 `str_replace_editor`——Standard 的沙箱 `bash` 行被禁用，改用持久 shell（同名、
  同层，见“为什么这样做”）。`read`/`write`/`edit` 继续使用沙箱文件系统，
  `str_replace_editor` 使用 preset 自己的本地 fs；
- bootstrap 工具缺失时降级为完整目录并一次性告警，不再让请求失败，组合漂移不会锁死
  会话；非法的 `promoteOn` 值会在 preset 挂载时报错；
- 晋升判定按会话在进程内记忆化，持久事件扫描每会话每进程只执行一次。
- 会话未晋升期间，pre-step 过滤器剥离 `source.kind` 列在 `suppressedContextSources`
  中的消息（默认 `agent-instructions` 与 `skill-catalog`，即 Standard 比 Minimal 多出的
  两项自动注入）。设为 `[]` 可关闭上下文过滤；加入其他 `source.kind` 可抑制更多。
  过滤器自身出错时降级为保留全部消息，绝不吞掉上下文。
- 工具目录只变化一次，因此第一、第二次请求之间也会发生一次前缀缓存变化；
- preset 与 shell 访问具有相同信任等级，安装前应自行审阅文件；
- 插件不会发起网络请求，也不增加遥测。

## Zero-Anchored Standard（实验）

这是不改变上面 Anchored Standard 逻辑的额外测试模式。它沿用同一套 Minimal
对齐的 system prompt，但首轮不再暴露两个工具，而是先注入一轮固定的零工具锚定
对话：

1. 用户发出第一条消息时，`anchor-turn` 插件会把固定消息——"This round is a
   test. Tools are not open yet; all tools will open next round."——插到它前面；
2. 第一个真实模型请求携带 **0 个工具**，首条思维链因此走零注入的 "we" 轨迹；
3. 锚定回复落库后开放完整 Standard 目录，真实消息带着全部工具继续。

锚定发生在第一条消息到达时而不是会话创建时，因此新建会话仍然可以先切换模式；
子 agent 始终看到完整目录。

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

1. 用户发出第一条消息时，`whoami-turn` 插件把固定消息——"你是谁"——prepend 到
   `next-turn` 收件队列、排在真实消息前面；
2. dsh 每轮只消费一条 `next-turn` 消息，因此第一个模型请求只看到锚定消息、
   携带 **0 个工具**，模型回复自我介绍，该回复即晋升信号；
3. 下一轮才轮到真实消息，此时晋升后的 resident 目录（shell、str_replace_editor、
   发现类工具）已解锁，重型 Standard 工具一次 `dev_tool_search` 即可取用。

锚定文本可通过 `whoami-turn` 行的 `text` 配置（默认"你是谁"）。锚定发生在第一条
消息到达时而非会话创建时，新建会话仍可先切换模式。设置 `includeSubagents: true`
后，子 agent 也会继承同样的流程：首轮先做"你是谁"自我介绍、工具为 0，真正的委托
任务在下一轮带着 resident 目录执行。代价是每个会话固定多一次模型调用——即使第一
条消息很紧急也会先跑自我介绍轮。

该预设通过 `../preset/` 引用与 anchored 的 `preset/` 目录共享插件模块，安装时
请一并安装该目录（见上文"安装"章节）。

以独立 preset id 安装：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/whoami-standard"
cp -R whoami-standard "$dsh_home/.agent-presets/whoami-standard"
```

重启 DeepSeek Harness，新建空白会话，选择 **Whoami Standard (experimental)**，
然后发送第一条消息——自我介绍轮先跑，你的消息在下一轮带着完整工具被回答。

## 官方生态要求

DeepSeek 当前建议社区作者把插件放在自己的 GitHub 项目中，并为仓库添加
[`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 方便发现。官方仓库目前不接受
外部 PR，也没有强制社区插件仓库模板。原文见官方
[`CONTRIBUTING.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/CONTRIBUTING.zh.md)。

## 许可证

MIT。`preset/agent.cordis.yml` 基于 DeepSeek Harness Standard preset 修改，原始 DeepSeek
版权和 MIT 许可声明保留在 [`NOTICE`](./NOTICE) 中。
