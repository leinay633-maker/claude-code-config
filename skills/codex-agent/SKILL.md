---
name: codex-agent
description: Claude Code 需要派子代理时默认用它代替 Agent 工具：用 Codex CLI 跑 gpt-6.1-sol（max），走 ChatGPT 订阅的官方登录，不花 Claude 额度。适用于查搜、回源核对、归纳材料、网页调研、独立审核、复杂排障、方案设计、按定好的方案做的批量改动等能写成独立提示词的子任务；可复用 ~/.claude/agents 下的代理定义（如 context-gatherer）。用户点名要 Claude 子代理、或任务必须继承本会话上下文时才用 Agent 工具。
---

# codex-agent：用 Codex CLI 代替子代理

`run-codex.ps1` 用 Codex CLI（`codex exec`）跑一个独立子代理，默认 `gpt-6.1-sol`、推理档 `max`，走 `~/.codex` 的官方登录。它带读文件、命令行和原生联网搜索，会读工作目录的 `AGENTS.md`。需要先装好 Codex CLI 并 `codex login`。

## 调用

1. 把任务写成独立提示词，存成 `$env:TEMP\codex-agent\` 下的 UTF-8 文件。子代理看不到本会话，提示词里要写清目标、已知事实、要查的路径范围、硬约束和交付格式。
2. 用 PowerShell 工具运行：

```powershell
& "$env:USERPROFILE\.claude\skills\codex-agent\run-codex.ps1" -PromptFile <提示词文件> [-Cwd <工作目录>] [-AddDir <目录>] [-Agent context-gatherer] [-Mode write] [-Resume <会话ID>] [-Model <模型>] [-Effort <档位>]
```

- `-Mode`：默认 `read`，只靠提示词要求不改文件、只跑只读命令；要它改文件才用 `write`。
- `-Agent`：把 `~/.claude/agents/<名>.md` 的正文拼进提示词；只读查搜用 `context-gatherer`。frontmatter 的 `tools` 不生效。
- `-Resume <ID>`：追问之前的会话，相当于 SendMessage。会话 ID 在输出末行。
- `-Cwd` 默认当前目录；超出工作目录的材料用 `-AddDir` 放行。
- 预计超过 2 分钟的任务用 `run_in_background`，跑完会自动通知；互相独立的子任务可以同时起几个。

输出是子代理的最终报告，末行写模型、用时、token、会话 ID 和全文路径。失败时退出码 1，并打出 stderr 的末尾。

## 什么时候派

- 能写成独立提示词的活主动派，不必等用户开口：要读大量文件或长材料但只需要结论的查搜、回源核对和归纳，网页调研，按定好的方案和样例做的批量机械改动，改完后的独立审核。
- 派出后放后台，主会话继续做不依赖它的部分。一两次搜索或读取就能答、只改一两处的活自己做。

## 用结果

- 结果直接用，不回读核对、不重做它的搜索；要改的正文仍由主会话自己读全文、自己改。
- 独立审核的首轮用同一份提示词同时起两个（错开几秒），各自放后台，两份都回来再合并：发现取并集，两份都提到的直接用，只有一份提到的由主会话判断取舍，结论不一致时按更严的算。按意见改完后的复核轮只派一个。
- 结果离题或明显错误时，改提示词重跑，或用 `-Resume` 追问；连续两次不行，就主会话自己做或改用 Agent 工具，并告诉用户。
- `-Mode write` 失败时先看它已经改了哪些文件，再决定重跑。
- Codex 不可用（没装、没登录、额度用完）时，这一次改用 Agent 工具，并在回复里说明原因和 stderr 路径。
