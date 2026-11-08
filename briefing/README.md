# AI 每日简报

每天抓取 Latent Space AINews、机器之心文章列表和 Hugging Face 每日论文，生成中文 Markdown，关注后训练、推荐系统、Agent 和模型发布。素材先保存，简报成功后才推进抓取水位；失败会在后续运行补上，最多补最近三天。已成功的当天简报自动跳过。

需要 Python 3.10 或更新版本，以及已通过官方订阅登录的 Claude Code，并让 `python`、`claude` 可在命令行找到。可选安装并通过 ChatGPT 官方登录的 Codex。CLI 需支持 Claude 的 `--safe-mode` 及 Codex 的 `--ignore-user-config`，旧版请先升级。Python 部分只用标准库，无须安装第三方包。将 `briefing.py`、`prompt.md`、`briefing-hidden.vbs`、`register-task.ps1` 放在同一个长期保留的文件夹；先在该文件夹执行：

```powershell
python -X utf8 briefing.py --dry-run
```

干跑只联网抓素材并生成提示词，不调用模型、不生成简报、不推进抓取水位。首次正常生成运行 `python -X utf8 briefing.py`；Windows 下使用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\register-task.ps1` 注册自动任务，默认本地时间每天 09:30，14:30 补跑当天未完成的内容。可加 `-Time '10:00' -RetryTime ''` 更改时间并关闭补跑；`-TaskName 'my-ai-briefing'` 使用其他名称。脚本只更新带有自身标记且入口属于此安装目录的任务，遇到其他同名任务会退出。任务使用当前已登录的 Windows 账号，睡眠错过后会补跑；完全退出账号期间不能运行。`-WhatIf` 可以预览注册操作。更改环境变量或安装位置后重新注册，以更新任务保存的参数。

默认输出在 `~/AI-Briefing/YYYY-MM/YYYY-MM-DD.md`，运行素材、提示词、日志和状态在同一输出目录的 `.briefing/` 下。加 `--web` 或注册时加 `-Web` 启用网页，入口是输出目录的 `site/index.html`，浏览器可直接打开。图片引用公开原图，优先使用 HF 论文配图，否则按每篇至少三秒的间隔查询 arXiv HTML，每次最多十五篇；打不开的图片自动隐藏。机器之心只请求一次最近二十篇的公开列表，不能补齐更早的文章，也不抓文章正文；HF 每次最多一百篇，使用 UTC 的往日榜单，周末可能为空。

| Python 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--output-dir` | `AI_BRIEFING_OUTPUT_DIR` | `~/AI-Briefing` |
| `--prompt-file` | `AI_BRIEFING_PROMPT_FILE` | 脚本旁的 `prompt.md` |
| `--board-dir` | `AI_BRIEFING_BOARD_DIR` | `~/.claude/board` |
| `--web` / `--no-web` | `AI_BRIEFING_WEB` | `false` |
| `--codex` / `--no-codex` | `AI_BRIEFING_CODEX` | `true` |
| `--claude-model` | `AI_BRIEFING_CLAUDE_MODEL` | `claude-opus-5-5` |
| `--claude-effort` | `AI_BRIEFING_CLAUDE_EFFORT` | `max` |
| `--codex-model` | `AI_BRIEFING_CODEX_MODEL` | `gpt-6.1-sol` |
| `--codex-effort` | `AI_BRIEFING_CODEX_EFFORT` | `high` |
| 注册脚本 `-Time` | `AI_BRIEFING_TIME` | `09:30`，本地时间 |
| 注册脚本 `-RetryTime` | `AI_BRIEFING_RETRY_TIME` | `14:30`，空值关闭 |
| 注册脚本 `-Python` | `AI_BRIEFING_PYTHON` | `python`，注册时固定实际解释器 |

命令参数覆盖环境变量；布尔值接受 `true/false`、`1/0`、`yes/no`、`on/off`。注册脚本也提供对应的 `-OutputDir`、`-PromptFile`、`-BoardDir`、`-ClaudeModel`、`-ClaudeEffort`、`-CodexModel`、`-CodexEffort`、`-Web`、`-NoWeb`、`-NoCodex`。修改 `prompt.md` 可调整简报范围和写法，需保留规定栏目及来源编号格式。`--force` 使用当天已保存的素材重写，配合 `--date YYYY-MM-DD` 可重写往期；`--site` 只重建已有简报的网页。退出码为 `0` 成功、`2` 有来源未抓到、`1` 失败。

如已安装额度看板，账号清单读取 `~/.claude/board/accounts.json`，格式为 `{"accounts":[{"id":"a","configDir":null},{"id":"b","configDir":".claude-b"}]}`。每个账号需事先单独完成官方登录，副号目录还需有 `account-settings.json`；它只应包含官方账号的普通设置。脚本按同目录 `acct-<id>.json` 的周用量、再按五小时用量从低到高尝试，未知用量排最后，重置时间已过则按零计算。`configDir: null` 使用主号且不设置 `CLAUDE_CONFIG_DIR`；副号使用家目录下的对应目录及其 `account-settings.json`。没有看板时只尝试主号，不要求安装看板。

正常生成消耗运行者已登录账号的订阅额度。先尝试 Claude，未完成时才调用 Codex；没有安装 Codex 会跳过，也可用 `--no-codex` 禁用。脚本清除 API 凭证及会改变账号选择的继承变量，Codex 固定官方 provider 和 ChatGPT 登录方式；不会自动登录。Claude 输出中的美元数字是 CLI 给出的 API 价格折算值，不表示额外扣款。整次运行最多约五十五分钟，给备用模型和落盘留出时间。命令参数可参考 [Claude Code CLI 文档](https://code.claude.com/docs/en/cli-reference) 和 [Codex CLI 文档](https://developers.openai.com/codex/cli/reference)。

离线检查运行 `python -X utf8 -m unittest -v test_briefing`；任务脚本检查运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\test_register_task.ps1`。这些测试使用临时素材、假的 CLI 输出及内存中的任务命令替身，不调用模型、不注册任务。发布时只复制上述四个运行文件、本文档、`test_briefing.py`、`test_register_task.ps1` 和 `.gitignore`，不要携带测试输出、运行记录或账号文件。
