# claude-code-config

我日常用的 Claude Code 配置里能通用的部分：全局规则、设置、状态栏、Windows Terminal 设置、标签页标题、长期记忆的接法、多账号、额度看板和预热、用 Codex 跑的子代理、AI 每日简报、做视频的 skill，以及换电脑用的安装和备份脚本。主要在 Windows 11 上用，脚本只支持 Windows。

换一台电脑，照着下面装一遍，就是我平时用的样子。

## 内容

| 路径 | 作用 |
| --- | --- |
| `global/AGENTS.md` | 全局规则：语言、沟通、替用户写文字、子代理、长期记忆、文件交付、Git 等 |
| `codex/config.example.toml` | Codex 设置：默认模型和档位、上下文、读 CLAUDE.md、关掉 Codex 自带的记忆 |
| `settings.example.json` | Claude Code 设置：模型和 effort、权限、记忆目录、精简上下文、界面、状态栏和标题 hook |
| `agents/context-gatherer.md` | 只读查搜子代理，结论要落到路径、行号和原文 |
| `skills/codex-agent/` | 派子代理时用 Codex CLI 跑 GPT，走 ChatGPT 订阅，不花 Claude 额度 |
| `skills/make-video/` | 做视频的入口：代码生成的 MV 走 [mv-engine](https://github.com/leinay633-maker/mv-engine)，讲解片和无旁白知识短片各有一份做法，其余按需加载 [HyperFrames](https://github.com/heygen-com/hyperframes) |
| `memory-seed/` | 新电脑的初始记忆：Windows、PowerShell、Git Bash 的坑，和做事、做视频的偏好 |
| `hooks/statusline.js` | 状态栏：模型、effort、目录和分支、上下文、5 小时和本周额度、缓存命中率、花费、行数增删；窄终端按优先级丢段落 |
| `hooks/tab-title*.ps1` | Windows Terminal 标签页标题：`/clear` 时还原；可选在提问时用模型压成十字以内的短标题，回合结束点亮完成标记 |
| `hooks/codex-session-memory.js` | Codex 开会话时注入记忆索引 |
| `hooks/cursor-session-start.js` | Cursor 开会话时注入全局规则和记忆索引 |
| `board/` | 额度看板：各个 Claude 账号和 Codex 的 5 小时、本周额度，窗口花费和近 1 小时速度 |
| `briefing/` | AI 每日简报：每天抓几个公开来源，用 Claude Code 写成中文简报 |
| `warmup/` | 预热：每天定时给各个号发一句短话，提前开起 5 小时窗口 |
| `windows/terminal/settings.json` | Windows Terminal 的配色、字体和快捷键 |
| `windows/ahk/` | 类 Mac 快捷键 |
| `windows/ngen-ps51.ps1` | 让 Windows PowerShell 5.1 冷启动变快，hook 和贴图跟着变快 |
| `scripts/install.ps1` | 把以上内容装到这台电脑 |
| `scripts/backup.ps1` | 把本机配置、会话记录和记忆快照到私有位置 |

## 安装

```powershell
git clone https://github.com/leinay633-maker/claude-code-config.git
cd claude-code-config
./scripts/install.ps1 -DryRun   # 先看会动哪些文件
./scripts/install.ps1           # 按需加 -Accounts b,c、-Board、-Warmup、-Briefing、-Codex、-Cursor
```

仓库只是模板，每台电脑各自一份。脚本把规则复制成 `~/.claude/CLAUDE.md`，skills、子代理和脚本复制进 `~/.claude`，并建好记忆目录 `~/.claude/memory`。之后改的都是本机那份，不回写仓库，也不和别的电脑同步；装完删掉克隆的仓库也不影响使用。

- 已有的文件不覆盖，重跑只补上仓库里新增的 skill 和子代理。
- `git pull` 后想用新版脚本，加 `-Update`：只刷新状态栏、标题、记忆注入和看板的代码，旧的先备份到 `~/.claude-config-backup/<时间戳>/`。规则、skills、子代理和记忆不动。
- `~/.claude/settings.json` 不存在时，用 `settings.example.json` 生成一份，里面的 `~/.claude`、`$USERPROFILE` 换成本机绝对路径：没有 Git Bash 时 Claude Code 用 PowerShell 跑命令，这两种写法都展开不了。已存在时不改，需要的部分自己合并，合并时也把路径换掉。
- `-Accounts b,c`：开副号，见下面“多账号”。
- `-Board`：装额度看板，见下面“额度看板”。
- `-Warmup`：装预热，见下面“预热”。
- `-Briefing`：装 AI 每日简报，见下面“每日简报”。
- `-Codex`：`~/.codex/AGENTS.md`、`~/.agents/skills` 软链到 `~/.claude` 那份，在 `~/.codex/hooks.json` 装上注入记忆索引的 hook；`~/.codex/config.toml` 不存在时从 `codex/config.example.toml` 复制。如果 Codex 提示要信任这个新 hook，选信任。
- `-Cursor`：`~/.cursor/skills`、`~/.cursor/agents` 软链到 `~/.claude` 那份。Cursor 不读用户级的 AGENTS.md，所以在 `~/.cursor/hooks.json` 装一个 hook，开会话时注入全局规则和记忆索引。

软链位置上原有的文件或目录会移到备份目录，建链失败时搬回原处。`hooks.json` 已存在时不改，脚本会打印要合并的那段。用到软链时，Windows 要开启开发者模式，或用管理员身份运行。

状态栏、记忆注入和看板要装 [Node.js](https://nodejs.org/)，codex-agent 要装 [Codex CLI](https://github.com/openai/codex) 并 `codex login`。

## 记忆

记忆放在 `~/.claude/memory/`，一条一个文件，`MEMORY.md` 是索引。新电脑第一次安装、这里还没有 `MEMORY.md` 时，脚本放进 `memory-seed/` 的二十几条通用经验当起点；之后不再动它，删掉的条目重跑也不会加回来。`settings.example.json` 的 `autoMemoryDirectory` 让 Claude Code 在任何目录都读写这一份，不再按项目分开；Codex、Cursor 开会话时由 hook 读入索引。规则里写了什么该记、记了以后怎么核实。

每台电脑的记忆各管各的。里面常有本机路径和个人信息，不要放进 Git 仓库或软链到云盘；换电脑要带走旧记忆，就用下面的备份脚本拷过去。

## 多账号

`-Accounts b,c` 给同一台电脑开副号。主号叫 a，就是 `~/.claude`；副号各自在 `~/.claude-b`、`~/.claude-c` 里登录，只有登录信息是自己的，规则、设置、skills、子代理、插件、会话记录、prompt 历史和记忆都软链到主号。所以换号后 `/resume` 能直接接上之前的会话。

脚本在 `claude` 命令旁边生成 `claude-a`、`claude-b`、`claude-c` 几个入口（`.cmd` 给 cmd 和 PowerShell，无扩展名的给 Git Bash），第一次运行副号要 `/login`。副号名用小写字母、数字和连字符，`a` 是主号、`codex` 留给预热，都不能用。副号启动时带 `account-settings.json`：从家目录启动时，`~/.claude/CLAUDE.md` 会被当成项目规则再读一遍，这份设置把它排除掉。这个文件已经存在时不覆盖，缺排除项就打印出要并进去的那段。

已经在用的副号目录也可以接进来：它原有的会话记录和 prompt 历史先并进主号（同名不覆盖），原目录移到备份目录。副号还开着会话时跳过它，退出后重跑。

装了看板时，状态栏会显示当前是哪个号（A号、B号……）。

## 额度看板

`-Board` 把 `board/` 装到 `~/.claude/board/`，并在注册表 `HKCU\...\Run` 里加一项 `claude-board`，登录后在后台起看板服务（默认端口 8411，可用环境变量 `CLAUDE_BOARD_PORT` 改）。

- 浏览器打开 `http://127.0.0.1:8411/` 就能看（改了端口就换成那个端口）。每个账号一张卡：5 小时和本周额度、重置时间、当前窗口按 API 价折算的花费、近 1 小时的输出速度。装了 Codex 时多一张 Codex 卡。
- 直接双击 `~/.claude/board/index.html` 是离线模式，只显示状态栏写的快照，不连服务。改了端口时在地址后加 `?port=端口`，页面上“实时数据请打开”的链接才对。
- 数据来自两处，都不额外发请求：状态栏把每个号收到的额度快照和花费增量写进看板目录；后台服务按会话记录现算花费和速度，Codex 的额度向本机的 `codex app-server` 读。
- 服务只听 `127.0.0.1`，只回应从看板页面本身发来的请求，别的网页读不到里面的邮箱和额度。
- 账号清单是安装时写的 `accounts.json`；之后加了副号，带 `-Accounts` 和 `-Board` 重跑一遍。
- 服务没起来时运行 `~/.claude/board/start-hidden.vbs`。注册表里已有一项叫 `claude-board`、但指向别处的开机启动，安装时保留不改，会提示你自己处理。

## 预热

5 小时窗口从第一次请求开始算。`-Warmup` 注册一个计划任务 `claude-warmup`，每天 9、14、19 点（本机时间，各随机推迟 0 到 10 分钟）给每个号发一句 `hi`，让窗口按固定时刻滚动，正好接上上班、午后和晚上三段。时间可以用 `-WarmupTimes '08:30','13:30'` 改。

- Claude 各号用 `claude -p` 和 haiku 发，不留会话记录；账号清单取看板的 `accounts.json`，没装看板就只有主号。
- 装了 Codex 时也发一次，用最便宜的 `gpt-6-luna`，满载时换 `gpt-6.1-terra` 再试。Codex 的窗口从请求那一秒算，发之前先看旧窗口：20 分钟内结束就等它结束再发；还早、而且已经有用量，就跳过这次。发完再确认新窗口开出来没有。
- 只走订阅登录：脚本先清掉 `ANTHROPIC_*`、`OPENAI_API_KEY` 这类会让请求改走 API key 的环境变量，Codex 固定用 ChatGPT 登录。整次运行控制在 27 分钟内，剩的时间不够就跳过后面的号，不会撞上计划任务 30 分钟的上限。
- 结果写进 `~/.claude/warmup/warmup.log`，装了看板时每张卡上也显示最近一次预热的结果。
- 已经有同名计划任务、但不是本脚本建的，不覆盖。手动跑：`~/.claude/warmup/warmup.ps1 -Accounts a`。

## 每日简报

`-Briefing` 把 `briefing/` 装到 `~/.claude/briefing/`，注册计划任务 `ai-briefing`：每天 09:30 抓 Latent Space 的 AINews、机器之心和 Hugging Face 每日论文，用 Claude Code（Opus 5.5、max）写成中文简报，14:30 补跑没完成的。

- 输出在 `~/AI-Briefing/年-月/日期.md`。关注的方向写在 `~/.claude/briefing/prompt.md`，默认是后训练、推荐和 Agent，外加当天发布的模型，自己改这个文件就行。
- 装了看板时按各号本周用量从低到高轮着用；Claude 都没写成时转 Codex。花的都是自己的订阅额度。
- 要 Python 3.10 以上，只用标准库。先在 `~/.claude/briefing` 里跑 `python -X utf8 briefing.py --dry-run` 看抓取是否正常，它不调模型。时间、输出目录、模型、网页版等配置见 `briefing/README.md`。

## 子代理

`skills/codex-agent` 让 Claude Code 派子代理时改用 Codex CLI 跑 `gpt-6.1-sol`（推理档 `max`），走 ChatGPT 订阅的官方登录，不花 Claude 额度。规则里写了默认用它，什么时候自己做、什么时候派、审核怎么派两份再合并，都在它的 `SKILL.md` 里。只读查搜可以带上 `-Agent context-gatherer` 复用那个子代理的定义。

## 设置

`settings.example.json` 是我的 Claude Code 设置，去掉了账号和本机路径：

- 模型：默认 Opus，effort `xhigh`，显示思考摘要；Opus 5.5 到 60 万 token 才自动压缩，上下文窗口没这么大就删掉 `autoCompactWindow`。子代理也固定用 Opus 5.5。
- 权限：`bypassPermissions` 并跳过确认，工具调用一律不问。不想这样，就删掉 `permissions` 和 `skipDangerousModePermissionPrompt`。
- 精简上下文：关掉 Artifact、claude.ai 连接器和几个用不上的内置 skill。
- 界面：深色主题；`"tui": "fullscreen"` 用全屏渲染器，`CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` 配合它整屏重画；`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` 关掉 Claude Code 自己写的标签页标题，免得和标题脚本互相覆盖。
- Windows：`CLAUDE_CODE_USE_POWERSHELL_TOOL=1` 打开 PowerShell 工具；通知走终端响铃，配合下面的 Windows Terminal 设置只闪任务栏、不出声。

Codex 的设置在 `codex/config.example.toml`：默认 `gpt-6.1-sol`、`max`、fast 档，80 万 token 自动压缩，不审批、不进沙箱，项目里没有 AGENTS.md 时读 CLAUDE.md，关掉 Codex 自己的记忆（统一用 `~/.claude/memory`），再加几项桌面版的界面和通知设置。

Claude Code 在 Windows 上每次 Alt+V 贴图、每个用 `powershell.exe` 跑的 hook 都要现起一个 Windows PowerShell 5.1，冷启动常要 1 秒左右。以管理员身份打开 Windows PowerShell（不是 pwsh）跑一次 `windows/ngen-ps51.ps1`，能降到 0.3 秒左右。Windows 的 .NET 更新会让它失效，又变慢时重跑。

## Windows Terminal

`windows/terminal/settings.json` 是我的 Windows Terminal 设置，去掉了本机的配置文件列表。配色和标签栏是 Catppuccin Mocha，字体是 JetBrainsMono NF，要先装 [Nerd Fonts](https://www.nerdfonts.com/font-downloads) 里的 JetBrainsMono，没装会退回 Cascadia Mono。

不要整份覆盖。在 Windows Terminal 设置里点“打开 JSON 文件”，把 `profiles.defaults`、`schemes`、`themes`、`actions`、`keybindings` 和末尾几项合并进去，保留自己的 `profiles.list` 和 `defaultProfile`。

| 键 | 动作 |
| --- | --- |
| `Alt+1` … `Alt+9` | 切到第几个标签 |
| `Alt+T`、`Alt+W` | 新标签、关标签 |
| `Alt+Shift+D` | 分屏 |
| `Ctrl+C` | 有选区时复制，没有时照常发给程序 |
| `Ctrl+V`、`Ctrl+Shift+V` | Windows Terminal 自己的文本粘贴 |
| `Ctrl+Shift+F` | 查找 |

剪贴板里只有图片时，Windows Terminal 的粘贴会吞掉按键。贴截图用 Claude Code 的 `Alt+V`，或开着 `windows/ahk/hotkeys.ahk` 直接按 `Ctrl+V`。

## 标签页标题

示例只注册了 SessionStart、SessionEnd 两条：`/clear` 后把标签页标题还原成 Windows Terminal 的配置名。

想在提问时换成短标题、回合结束时在标签上显示完成的进度环（颜色跟随系统主题色），再往 `hooks` 里加这两条：

```json
"UserPromptSubmit": [
  { "matcher": "", "hooks": [{ "type": "command", "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$USERPROFILE\\.claude\\tab-title.ps1\"" }] }
],
"Stop": [
  { "matcher": "", "hooks": [{ "type": "command", "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$USERPROFILE\\.claude\\tab-title-idle.ps1\"" }] }
]
```

安装脚本生成的 `settings.json` 里路径已经是绝对路径，手动加这两条时把 `$USERPROFILE\\` 换成自己的家目录。

代价是每次提问和每轮结束，界面上都会出现 `running UserPromptSubmit hook`、`running Stop hooks…`，Windows PowerShell 冷启动大约要 0.6 秒。我嫌它碍眼，自己没开。

短标题要调模型，读环境变量 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，用 `TITLE_MODEL` 换模型（默认 `claude-sonnet-5-5`）。提问内容会发给这个接口。没有凭据时，标题就是提问的前 24 个字。

## 备份

```powershell
./scripts/backup.ps1 -Destination D:\private\cc-backup
```

默认备份 `~/.claude`（含记忆）、`~/.codex` 和 `~/.claude.json`，跳过缓存和软链。可选 `-ScheduledTasks` 导出计划任务，`-IncludeUserEnv` 导出用户环境变量（里面常有密钥，默认不导）。

快照里有登录凭据、完整会话记录和记忆，只能放私有位置。目的地在 Git 仓库或本仓库目录里时，脚本会拒绝运行。`/MIR` 会删掉目的地里多出来的文件，请用一个专门的目录。

恢复时把快照里的目录拷回家目录，`home/.claude.json` 放回 `~/.claude.json`，再按原来的参数跑一遍 `install.ps1` 重建软链；已有的文件它不会覆盖。

## 做视频

`skills/make-video` 假设 HyperFrames 装好但在用户级禁用：

```powershell
claude plugin marketplace add heygen-com/hyperframes
claude plugin install hyperframes@hyperframes
claude plugin disable hyperframes@hyperframes
```

## 快捷键

用 [AutoHotkey v2](https://www.autohotkey.com/) 运行，开机自启可以在启动文件夹放一个快捷方式。

`windows/ahk/hotkeys.ahk`：

| 键 | 动作 |
| --- | --- |
| `Caps Lock` 短按 / 长按 | 切中英文 / 开关大写锁定 |
| 鼠标后退、前进键 | 上一个、下一个虚拟桌面 |
| `Win+Alt+方向键` | 精确半屏；同时按住垂直方向键成四分之一屏 |
| Chrome、Edge 里 `Alt+数字` | 切标签 |
| Chrome、Edge 里 `Alt+T`、`Alt+Shift+T`、`Alt+W` | 新标签、恢复标签、关标签 |
| Windows Terminal 里 `Ctrl+V` | 贴文字；剪贴板只有图片时存成 PNG，把路径贴给 Claude Code |

代价是 Chrome 里网页自己定义的 `Alt+数字`、`Alt+T`、`Alt+W` 按不到。

`windows/ahk/MacFullscreen/MacFullscreen.ahk`：`Win+Alt+F` 让当前窗口进出独占的虚拟桌面。需要 Windows 11 24H2 26100.2605 以上，并把 [VirtualDesktopAccessor](https://github.com/Ciantic/VirtualDesktopAccessor) 的 `VirtualDesktopAccessor.dll` 放到脚本同目录。

## 许可

[MIT](LICENSE)
