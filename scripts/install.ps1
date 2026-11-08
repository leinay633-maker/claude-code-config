# 把本仓库当模板，装到这台电脑的 Claude Code（可选多账号、额度看板、Codex、Cursor）。换电脑时跑一次，可反复运行。
#
# 每台电脑各自一份：规则、skills、子代理和脚本复制进 ~/.claude，记忆放 ~/.claude/memory。
# 之后改的是本机那份，不回写本仓库，也不和别的电脑同步。
# 已存在的文件不覆盖，重跑只补上仓库里新增的 skill 和子代理；-Update 只刷新脚本。
#
# 同一台电脑上的副号、Codex、Cursor 共用 ~/.claude 那一份，靠软链接过去。
# 软链位置上原有的文件或目录不会删除，会移到 ~/.claude-config-backup/<时间戳>/，建链失败时搬回原处。
# 用到软链时，Windows 要开启开发者模式，或用管理员身份运行。

param(
    # 本仓库根目录
    [string]$Root = (Split-Path $PSScriptRoot -Parent),
    # 副号的名字，例如 'b','c'：各自在 ~/.claude-<名> 登录，其余配置、会话历史和记忆都和主号共用；主号叫 a
    [string[]]$Accounts = @(),
    # 副号命令入口（claude-<名>.cmd 等）放哪，默认和 claude 命令同一个目录
    [string]$BinDir = '',
    # 装额度看板到 ~/.claude/board，并设成开机后台启动
    [switch]$Board,
    # 装预热到 ~/.claude/warmup，并注册计划任务 claude-warmup：每天按 -WarmupTimes 给各号发一句短话，提前开 5 小时窗口
    [switch]$Warmup,
    # 本机时间，每个时刻随机推迟 0–10 分钟
    [string[]]$WarmupTimes = @('09:00', '14:00', '19:00'),
    # 装 AI 每日简报到 ~/.claude/briefing，并注册计划任务 ai-briefing（默认每天 09:30，14:30 补跑），输出在 ~/AI-Briefing
    [switch]$Briefing,
    # 装命令行设置：PowerShell 7 的配置文件里加一行，加载 ~/.claude/shell/profile.ps1；~/.config/starship.toml 没有时放一份
    [switch]$Shell,
    [switch]$Codex,
    [switch]$Cursor,
    # 用仓库里的新版覆盖本机的脚本（状态栏、标题、记忆注入、看板代码、命令行设置），旧的先备份；规则、skills、子代理和记忆不动
    [switch]$Update,
    [string]$HomeDir = $HOME,
    # 只打印会做什么，不改任何文件
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$Path) {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path).TrimEnd('\', '/')
}
function Test-Under([string]$Path, [string]$Dir) {
    ($Path.TrimEnd('\') + '\').StartsWith($Dir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

$Root = Get-FullPath $Root
$HomeDir = Get-FullPath $HomeDir
# 自启动、命令入口这些会动到当前用户的东西，只在装给当前用户时做；-HomeDir 指别处（比如测试）时跳过
$isRealHome = $HomeDir -eq (Get-FullPath $HOME)
if (-not (Test-Path -LiteralPath (Join-Path $Root 'global\AGENTS.md'))) { throw "不是本仓库的根目录：$Root" }
$Accounts = @($Accounts | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
foreach ($time in $WarmupTimes) {
    if ($time -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') { throw "预热时间要写成 HH:mm：$time" }
}
foreach ($id in $Accounts) {
    # a 是主号，codex 是预热和看板里 Codex 那一栏的名字
    if ($id -notmatch '^[a-z0-9][a-z0-9-]*$' -or $id -in 'a', 'codex') { throw "副号名只能用小写字母、数字和连字符，a 和 codex 留作他用：$id" }
}

$main = Join-Path $HomeDir '.claude'
if (Test-Under $Root $main) { throw "本仓库在 $main 里面，换个位置克隆再跑" }
$backupDir = Join-Path $HomeDir (".claude-config-backup\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$hookFiles = 'statusline.js', 'tab-title.ps1', 'tab-title-idle.ps1', 'tab-title-lib.ps1', 'tab-title-llm.ps1', 'tab-title-reset.ps1'

# 先试建一个软链，没有权限就在动任何文件之前停下
if (($Accounts.Count -gt 0 -or $Codex -or $Cursor) -and -not $DryRun) {
    $probe = Join-Path ([IO.Path]::GetTempPath()) ("link-probe-" + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType SymbolicLink -Path $probe -Target (Join-Path $Root 'global\AGENTS.md') | Out-Null
        Remove-Item -LiteralPath $probe -Force
    } catch {
        throw "建不了软链：开启开发者模式，或用管理员身份运行。$($_.Exception.Message)"
    }
}

function Get-Existing([string]$Path) { Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }

# 比较路径前统一规范化：.NET 会把 C:\Users\ABCDEF~1 这类短路径名展开成长名，两边都过一遍才对得上
function Get-NormPath([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }

# 软链的目标可能是相对路径，按链接所在目录解析成绝对路径
function Get-LinkTarget($Item) {
    $t = $Item.Target -join ''
    if (-not [IO.Path]::IsPathRooted($t)) { $t = Join-Path (Split-Path $Item.FullName -Parent) $t }
    Get-NormPath $t
}

# 移进备份目录，返回移到了哪
function Save-Existing([string]$Path) {
    $saved = Join-Path $backupDir $Path.Substring($HomeDir.Length).TrimStart('\', '/')
    New-Item -ItemType Directory -Force -Path (Split-Path $saved -Parent) | Out-Null
    Move-Item -LiteralPath $Path -Destination $saved
    $saved
}

# 指向本仓库的软链要换成本机的真文件，否则这台电脑还和仓库绑在一起
function Test-LinkIntoRepo($Item) {
    [bool]($Item -and $Item.LinkType -and (Test-Under (Get-LinkTarget $Item) (Get-NormPath $Root)))
}

# 本机这一份里出现指向别处的软链（比如云盘、另一个仓库），各电脑就可能互相影响。不替用户改，只提醒
function Warn-SharedLink($Item) {
    if ($Item -and $Item.LinkType -and -not (Test-LinkIntoRepo $Item)) {
        Write-Output "WARN   $($Item.FullName) 是软链，指向 $(Get-LinkTarget $Item)；那里如果是同步目录，别的电脑会跟着变"
    }
}

function Copy-One([string]$Src, [string]$Dst, [switch]$Refresh) {
    $existing = Get-Existing $Dst
    if ($existing -and -not (Test-LinkIntoRepo $existing)) {
        Warn-SharedLink $existing
        if (-not $Refresh -or $existing.PSIsContainer) { Write-Output "KEEP   $Dst"; return }
        if ((Get-FileHash -LiteralPath $Dst).Hash -eq (Get-FileHash -LiteralPath $Src).Hash) { Write-Output "OK     $Dst"; return }
    }
    if ($DryRun) {
        if ($existing) { Write-Output "BACKUP $Dst" }
        Write-Output "COPY   $Dst <- $Src"
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $Dst -Parent) | Out-Null
    if ($existing) { Write-Output "BACKUP $Dst -> $(Save-Existing $Dst)" }
    Copy-Item -LiteralPath $Src -Destination $Dst -Recurse
    Write-Output "COPY   $Dst <- $Src"
}

function Ensure-Dir([string]$Path) {
    $existing = Get-Existing $Path
    if (Test-LinkIntoRepo $existing) {
        if ($DryRun) { Write-Output "BACKUP $Path（指向仓库的软链，换成本机目录）"; return }
        Write-Output "BACKUP $Path -> $(Save-Existing $Path)"
        $existing = $null
    }
    Warn-SharedLink $existing
    if ($existing -and -not $existing.PSIsContainer) { throw "$Path 是文件，不是目录" }
    if (-not $existing -and -not $DryRun) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
}

function Link-One([string]$Link, [string]$Target) {
    if (-not $DryRun -and -not (Test-Path -LiteralPath $Target)) { throw "目标不存在：$Target" }
    # 入口是仓库本身或它的上级目录时，移走入口会把仓库一起搬走
    if (Test-Under $Root $Link) { throw "本仓库在 $Link 里面，换个位置克隆再跑" }
    # 不用 Test-Path 判断：它对失效软链返回 false，后面建链会报已存在
    $existing = Get-Existing $Link
    if ($existing -and $existing.LinkType -eq 'SymbolicLink' -and (Get-LinkTarget $existing) -eq (Get-NormPath $Target)) {
        Write-Output "OK     $Link"
        return
    }
    if ($DryRun) {
        if ($existing) { Write-Output "BACKUP $Link" }
        Write-Output "LINK   $Link -> $Target"
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $Link -Parent) | Out-Null
    $saved = $null
    if ($existing) {
        $saved = Save-Existing $Link
        Write-Output "BACKUP $Link -> $saved"
    }
    try {
        New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null
    } catch {
        if ($saved) {
            Move-Item -LiteralPath $saved -Destination $Link
            Write-Output "RESTORE $Link"
        }
        throw
    }
    Write-Output "LINK   $Link -> $Target"
}

# 写一个由本脚本生成的文件：不存在或内容变了才写。已存在但不是本脚本生成的（没有 $Marker），不动
function Write-Generated([string]$Path, [string]$Text, [string]$Marker, [switch]$Bom) {
    $existing = Get-Existing $Path
    if ($existing) {
        $old = [IO.File]::ReadAllText($Path)
        if ($old -eq $Text) { Write-Output "OK     $Path"; return }
        if ($Marker -and -not $old.Contains($Marker)) { Write-Output "KEEP   $Path（不是本脚本生成的，没改）"; return }
    }
    if ($DryRun) { Write-Output "WRITE  $Path"; return }
    New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding([bool]$Bom)))
    Write-Output "WRITE  $Path"
}

# settings.json 不存在时从示例生成，并把 ~/.claude 和 $USERPROFILE 换成本机绝对路径：
# 没有 Git Bash 时 Claude Code 用 PowerShell 跑命令，这两种写法都展开不了
function Write-Settings([string]$Cfg) {
    $dst = Join-Path $Cfg 'settings.json'
    $existing = Get-Existing $dst
    if ($existing) {
        Warn-SharedLink $existing
        Write-Output "KEEP   $dst（已存在，需要的设置从 settings.example.json 手动合并）"
        return
    }
    $text = [IO.File]::ReadAllText((Join-Path $Root 'settings.example.json'), [Text.Encoding]::UTF8)
    $fwd = ($main -replace '\\', '/')
    $text = $text.Replace('"node ~/.claude/statusline.js"', '"node \"' + $fwd + '/statusline.js\""')
    $text = $text.Replace('$USERPROFILE\\.claude\\', ($main -replace '\\', '\\') + '\\')
    Write-Generated $dst $text ''
}

# hooks.json 已存在时不改；里面没有指向本机脚本的那条命令，就打印要合并的段
function Write-HookJson([string]$Path, $Object, [string]$ScriptPath) {
    $json = $Object | ConvertTo-Json -Depth 8
    if (Get-Existing $Path) {
        $raw = [IO.File]::ReadAllText($Path)
        $escaped = $ScriptPath.Replace('\', '\\')
        if ($raw.Contains($escaped) -or $raw.Contains($ScriptPath.Replace('\', '/'))) { Write-Output "OK     $Path"; return }
        Write-Output "MERGE  $Path 已存在，里面没有指向 $ScriptPath 的命令，脚本没改它。把下面这段合并进去："
        Write-Output $json
        return
    }
    Write-Generated $Path $json ''
}

# ── ~/.claude：这台电脑自己的那一份
Warn-SharedLink (Get-Existing $main)
# Claude Code 的用户级说明只认配置目录下的 CLAUDE.md
Copy-One (Join-Path $Root 'global\AGENTS.md') (Join-Path $main 'CLAUDE.md')
Ensure-Dir (Join-Path $main 'skills')
foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Root 'skills') -Directory) {
    Copy-One $item.FullName (Join-Path $main "skills\$($item.Name)")
}
Ensure-Dir (Join-Path $main 'agents')
foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Root 'agents') -Filter '*.md' -File) {
    Copy-One $item.FullName (Join-Path $main "agents\$($item.Name)")
}
foreach ($file in $hookFiles) {
    Copy-One (Join-Path $Root "hooks\$file") (Join-Path $main $file) -Refresh:$Update
}
# settings.example.json 的 autoMemoryDirectory 指向这里
$memory = Join-Path $main 'memory'
Ensure-Dir $memory
# 这台电脑还没有记忆时，放进 memory-seed 里的通用经验当起点；有了就不再动，删掉的条目重跑也不会加回来
if (-not (Test-Path -LiteralPath (Join-Path $memory 'MEMORY.md'))) {
    $seed = @(Get-ChildItem -LiteralPath (Join-Path $Root 'memory-seed') -Filter '*.md' -File)
    if ($DryRun) { Write-Output "SEED   $memory（$($seed.Count) 个文件）" }
    else {
        foreach ($f in $seed) {
            $to = Join-Path $memory $f.Name
            if (-not (Test-Path -LiteralPath $to)) { Copy-Item -LiteralPath $f.FullName -Destination $to }
        }
        Write-Output "SEED   $memory（$($seed.Count) 个文件）"
    }
}
Write-Settings $main

# ── 副号：~/.claude-<名> 只放自己的登录（.credentials.json、.claude.json），其余软链到主号
if ($Accounts.Count -gt 0) {
    # 共用的东西主号这边先要有
    foreach ($dir in 'projects', 'file-history', 'plugins') {
        if (-not $DryRun) { New-Item -ItemType Directory -Force -Path (Join-Path $main $dir) | Out-Null }
    }
    $history = Join-Path $main 'history.jsonl'
    if (-not $DryRun -and -not (Test-Path -LiteralPath $history)) { New-Item -ItemType File -Path $history | Out-Null }

    $claudeCmd = Get-Command claude.cmd, claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $marker = 'Generated by claude-code-config install.ps1'
    $userHomeVar = if ($isRealHome) { '%USERPROFILE%' } else { $HomeDir }

    foreach ($id in @('a') + $Accounts) {
        if ($id -ne 'a') {
            $cfg = Join-Path $HomeDir ".claude-$id"
            # 账号正开着时换软链会让正在写的会话记录断掉
            $live = @(Get-ChildItem -LiteralPath (Join-Path $cfg 'sessions') -Filter '*.json' -ErrorAction SilentlyContinue |
                Where-Object { $_.BaseName -match '^\d+$' -and (Get-Process -Id ([int]$_.BaseName) -ErrorAction SilentlyContinue) })
            if ($live.Count -gt 0) { Write-Output "SKIP   $cfg 还有会话在跑（pid $($live.BaseName -join ',')），退出后重跑"; continue }

            # 已经在用的副号：会话记录和 prompt 历史先并进主号（同名不覆盖），再换成软链
            foreach ($dir in 'projects', 'file-history') {
                $own = Get-Existing (Join-Path $cfg $dir)
                if ($own -and -not $own.LinkType -and $own.PSIsContainer) {
                    $prefix = $own.FullName.TrimEnd('\').Length + 1
                    foreach ($f in Get-ChildItem -LiteralPath $own.FullName -Recurse -File -Force) {
                        $to = Join-Path (Join-Path $main $dir) $f.FullName.Substring($prefix)
                        if (Test-Path -LiteralPath $to) { continue }
                        if ($DryRun) { Write-Output "MERGE  $to"; continue }
                        New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent) | Out-Null
                        Copy-Item -LiteralPath $f.FullName -Destination $to
                    }
                }
            }
            $ownHistory = Get-Existing (Join-Path $cfg 'history.jsonl')
            if ($ownHistory -and -not $ownHistory.LinkType) {
                $lines = @(Get-Content -LiteralPath $ownHistory.FullName -Encoding UTF8 | Where-Object { $_ })
                if ($lines.Count -gt 0 -and -not $DryRun) { [IO.File]::AppendAllText($history, ($lines -join "`n") + "`n", (New-Object Text.UTF8Encoding($false))) }
                if ($lines.Count -gt 0) { Write-Output "APPEND $($lines.Count) 行 -> $history" }
            }

            foreach ($name in 'CLAUDE.md', 'skills', 'agents', 'settings.json', 'projects', 'file-history', 'plugins', 'history.jsonl') {
                Link-One (Join-Path $cfg $name) (Join-Path $main $name)
            }
            foreach ($name in 'settings.local.json', 'keybindings.json') {
                if (Test-Path -LiteralPath (Join-Path $main $name)) { Link-One (Join-Path $cfg $name) (Join-Path $main $name) }
            }
            # 副号从家目录启动时，~/.claude/CLAUDE.md 会被当成项目规则再加载一遍；启动时用 --settings 排除它
            $exclPaths = @(((Join-Path $main 'CLAUDE.md') -replace '\\', '/'), ((Join-Path $main 'AGENTS.md') -replace '\\', '/'))
            $acctSettings = Join-Path $cfg 'account-settings.json'
            $excl = [ordered]@{ claudeMdExcludes = $exclPaths } | ConvertTo-Json
            if (Get-Existing $acctSettings) {
                # 已有的可能带着用户自己的设置，不改它；排除项不全时打印要合并的内容
                $have = @()
                try { $have = @((Get-Content -Raw -Encoding UTF8 $acctSettings | ConvertFrom-Json).claudeMdExcludes) } catch {}
                if (@($exclPaths | Where-Object { $have -notcontains $_ }).Count -eq 0) { Write-Output "OK     $acctSettings" }
                else { Write-Output "MERGE  $acctSettings 已存在，脚本没改它。把下面的 claudeMdExcludes 合并进去："; Write-Output $excl }
            } else { Write-Generated $acctSettings $excl '' }
        }

        # 命令入口放在 claude 命令旁边：claude-<名>.cmd 给 cmd 和 PowerShell，claude-<名> 给 Git Bash
        if (-not $BinDir) {
            if (-not $isRealHome) { continue }
            if (-not $claudeCmd) { Write-Output "WARN   找不到 claude 命令，先装 Claude Code 再重跑，才能生成 claude-$id 入口"; continue }
            $BinDir = Split-Path $claudeCmd.Source -Parent
        }
        $binDir = $BinDir
        # .cmd 只能用 ASCII：cmd 按系统代码页读文件
        if ($id -eq 'a') {
            $cmdText = "@echo off`r`nrem $marker`: main account; clears CLAUDE_CONFIG_DIR inherited from another account`r`nsetlocal`r`nset `"CLAUDE_CONFIG_DIR=`"`r`ncall claude %*`r`nexit /b %ERRORLEVEL%`r`n"
            $shText = "#!/usr/bin/env bash`n# $marker`: main account; clears CLAUDE_CONFIG_DIR inherited from another account`nunset CLAUDE_CONFIG_DIR`nexec claude `"`$@`"`n"
        } else {
            $cmdText = "@echo off`r`nrem $marker`: Claude Code with the login in .claude-$id`r`nsetlocal`r`nset `"CLAUDE_CONFIG_DIR=$userHomeVar\.claude-$id`"`r`ncall claude --settings `"$userHomeVar\.claude-$id\account-settings.json`" %*`r`nexit /b %ERRORLEVEL%`r`n"
            $shText = "#!/usr/bin/env bash`n# $marker`: Claude Code with the login in .claude-$id`ndir=`"`$HOME/.claude-$id`"`nif command -v cygpath >/dev/null 2>&1; then dir=`"`$(cygpath -w `"`$dir`")`"; fi`nexport CLAUDE_CONFIG_DIR=`"`$dir`"`nexec claude --settings `"`$dir/account-settings.json`" `"`$@`"`n"
        }
        Write-Generated (Join-Path $binDir "claude-$id.cmd") $cmdText $marker
        Write-Generated (Join-Path $binDir "claude-$id") $shText $marker
    }
}

# ── 额度看板：代码和数据都在 ~/.claude/board，状态栏看到这个目录存在才开始记账
if ($Board) {
    $boardDir = Join-Path $main 'board'
    Ensure-Dir $boardDir
    # self-test.js 和 .gitignore 只给仓库用，不装
    foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Root 'board') -File | Where-Object { $_.Name -notin '.gitignore', 'self-test.js' }) {
        Copy-One $item.FullName (Join-Path $boardDir $item.Name) -Refresh:$Update
    }
    # 账号清单：主号 a，加上装过的副号（有 account-settings.json 的 ~/.claude-<名>）
    $list = @([ordered]@{ id = 'a'; configDir = $null })
    foreach ($d in Get-ChildItem -LiteralPath $HomeDir -Directory -Force -Filter '.claude-*' -ErrorAction SilentlyContinue) {
        if ($d.Name -match '^\.claude-([a-z0-9][a-z0-9-]*)$' -and ((Test-Path -LiteralPath (Join-Path $d.FullName 'account-settings.json')) -or $Accounts -contains $Matches[1])) {
            $list += [ordered]@{ id = $Matches[1]; configDir = $d.Name }
        }
    }
    foreach ($id in $Accounts) {
        if (-not ($list | Where-Object { $_.id -eq $id })) { $list += [ordered]@{ id = $id; configDir = ".claude-$id" } }
    }
    $accountsJson = ConvertTo-Json -InputObject ([ordered]@{ accounts = @($list) }) -Depth 4
    Write-Generated (Join-Path $boardDir 'accounts.json') $accountsJson ''
    Write-Generated (Join-Path $boardDir 'accounts.js') ("window.ACCOUNTS = " + (ConvertTo-Json -InputObject @($list) -Depth 4 -Compress) + ";`n") ''

    if ($isRealHome) {
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        $runValue = "wscript.exe `"$(Join-Path $boardDir 'start-hidden.vbs')`""
        $current = (Get-ItemProperty -Path $runKey -Name 'claude-board' -ErrorAction SilentlyContinue).'claude-board'
        $port = if ($env:CLAUDE_BOARD_PORT) { $env:CLAUDE_BOARD_PORT } else { '8411' }
        $startNow = "现在要用就运行 $(Join-Path $boardDir 'start-hidden.vbs')"
        if ($current -eq $runValue) { Write-Output "OK     开机启动 claude-board" }
        # 同名的启动项不是指向这个看板目录的，是别人的，不覆盖
        elseif ($current -and $current.IndexOf($boardDir, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Write-Output "KEEP   开机启动项 claude-board 已存在（$current），不是本脚本写的，没改它；这个看板的服务不会开机自启"
        }
        elseif ($DryRun) { Write-Output "RUN    开机启动 claude-board：$runValue" }
        else { Set-ItemProperty -Path $runKey -Name 'claude-board' -Value $runValue; Write-Output "RUN    开机启动 claude-board：$runValue" }
        Write-Output "BOARD  浏览器打开 http://127.0.0.1:$port/ 看额度，$startNow"
    }
}

# ── 预热：脚本放 ~/.claude/warmup，计划任务每天定时跑
if ($Warmup) {
    $warmDir = Join-Path $main 'warmup'
    Ensure-Dir $warmDir
    foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Root 'warmup') -File) {
        Copy-One $item.FullName (Join-Path $warmDir $item.Name) -Refresh:$Update
    }
    if ($isRealHome) {
        $vbs = Join-Path $warmDir 'warmup-hidden.vbs'
        $task = Get-ScheduledTask -TaskName 'claude-warmup' -ErrorAction SilentlyContinue
        if ($task -and (@($task.Actions | ForEach-Object { $_.Arguments }) -join ' ').IndexOf($vbs, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Write-Output "KEEP   计划任务 claude-warmup 已存在，不是本脚本建的，没改它"
        } elseif ($DryRun) {
            Write-Output "TASK   计划任务 claude-warmup：每天 $($WarmupTimes -join '、') 跑 $vbs"
        } else {
            $triggers = @($WarmupTimes | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ -RandomDelay (New-TimeSpan -Minutes 10) })
            $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
            # 计划任务最多跑 30 分钟：Codex 遇到旧窗口快结束时会等它结束再发
            $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
            Register-ScheduledTask -TaskName 'claude-warmup' -Trigger $triggers -Action $action -Settings $settings -Description "claude-code-config 预热：$vbs" -Force | Out-Null
            Write-Output "TASK   计划任务 claude-warmup：每天 $($WarmupTimes -join '、') 跑 $vbs"
        }
    }
}

# ── AI 每日简报：脚本放 ~/.claude/briefing，计划任务由它自带的 register-task.ps1 注册
if ($Briefing) {
    $briefDir = Join-Path $main 'briefing'
    Ensure-Dir $briefDir
    foreach ($name in 'briefing.py', 'briefing-hidden.vbs', 'register-task.ps1', 'README.md', 'test_briefing.py', 'test_register_task.ps1') {
        Copy-One (Join-Path $Root "briefing\$name") (Join-Path $briefDir $name) -Refresh:$Update
    }
    # 提示词是给人改的，-Update 也不覆盖
    Copy-One (Join-Path $Root 'briefing\prompt.md') (Join-Path $briefDir 'prompt.md')
    if ($isRealHome) {
        $py = Get-Command python.exe, py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $py) { Write-Output "WARN   找不到 Python 3.10+，装好后运行 $(Join-Path $briefDir 'register-task.ps1') 注册计划任务" }
        elseif ($DryRun) { Write-Output "TASK   计划任务 ai-briefing：由 $(Join-Path $briefDir 'register-task.ps1') 注册" }
        else {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $briefDir 'register-task.ps1') -Python $py.Source
            if ($LASTEXITCODE -ne 0) { Write-Output "WARN   计划任务 ai-briefing 没注册成功（退出码 $LASTEXITCODE），见上面的输出" }
        }
    }
}

# ── 命令行：已有的配置文件不动，只在末尾加一行加载 ~/.claude/shell/profile.ps1
if ($Shell) {
    $shellProfile = Join-Path $main 'shell\profile.ps1'
    Copy-One (Join-Path $Root 'windows\shell\profile.ps1') $shellProfile -Refresh:$Update
    # 提示符样式是给人改的，-Update 也不覆盖
    Copy-One (Join-Path $Root 'windows\shell\starship.toml') (Join-Path $HomeDir '.config\starship.toml')

    # 只管 PowerShell 7：Windows PowerShell 默认不许跑脚本，给它加配置文件，每次启动都会报错。
    # Documents 可能被重定向到 OneDrive，不能直接拼家目录
    $docs = if ($isRealHome) { [Environment]::GetFolderPath('MyDocuments') } else { Join-Path $HomeDir 'Documents' }
    $profilePath = Join-Path $docs 'PowerShell\Microsoft.PowerShell_profile.ps1'
    Warn-SharedLink (Get-Existing $profilePath)
    if ((Test-Path -LiteralPath $profilePath) -and [IO.File]::ReadAllText($profilePath).Contains('claude-code-config')) {
        Write-Output "OK     $profilePath"
    } elseif ($DryRun) {
        Write-Output "APPEND 加载命令行设置 -> $profilePath"
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $profilePath -Parent) | Out-Null
        # 只写 ASCII，能接在无 BOM 的 UTF-8 或 ANSI 后面；UTF-16 的文件要按 UTF-16 追加，否则会写坏
        $encoding = [Text.Encoding]::ASCII
        if (Test-Path -LiteralPath $profilePath) {
            $head = [IO.File]::ReadAllBytes($profilePath)
            if ($head.Length -ge 2 -and $head[0] -eq 0xFF -and $head[1] -eq 0xFE) { $encoding = [Text.Encoding]::Unicode }
        }
        $loadPath = if ($isRealHome) { '$HOME\.claude\shell\profile.ps1' } else { $shellProfile }
        [IO.File]::AppendAllText($profilePath, "`r`n# claude-code-config: shell settings. Delete the next line to turn them off.`r`nif (Test-Path `"$loadPath`") { . `"$loadPath`" }`r`n", $encoding)
        Write-Output "APPEND 加载命令行设置 -> $profilePath"
    }
    if ($isRealHome) {
        if (-not (Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue)) { Write-Output "WARN   还没装 PowerShell 7，命令行设置装好才生效：winget install Microsoft.PowerShell" }
        if (-not (Get-Command starship -CommandType Application -ErrorAction SilentlyContinue)) { Write-Output "WARN   还没装 Starship，提示符装好才生效：winget install Starship.Starship" }
    }
}

if ($Codex) {
    Link-One (Join-Path $HomeDir '.codex\AGENTS.md') (Join-Path $main 'CLAUDE.md')
    # Codex 从 ~/.agents/skills 读用户级 skills，~/.codex/skills 留给它的内置 skill
    Link-One (Join-Path $HomeDir '.agents\skills') (Join-Path $main 'skills')
    # config.toml 不存在时从示例复制；已存在时不改，需要的部分自己合并
    $codexCfg = Join-Path $HomeDir '.codex\config.toml'
    if (Test-Path -LiteralPath $codexCfg) { Write-Output "KEEP   $codexCfg（已存在，需要的设置从 codex\config.example.toml 手动合并）" }
    else { Copy-One (Join-Path $Root 'codex\config.example.toml') $codexCfg }
    $js = Join-Path $HomeDir '.codex\hooks\session_memory.js'
    Copy-One (Join-Path $Root 'hooks\codex-session-memory.js') $js -Refresh:$Update
    Write-HookJson (Join-Path $HomeDir '.codex\hooks.json') ([ordered]@{
        hooks = [ordered]@{
            SessionStart = @([ordered]@{
                matcher = 'startup|resume|clear|compact'
                hooks   = @([ordered]@{
                    type                   = 'command'
                    command                = 'node "$HOME/.codex/hooks/session_memory.js"'
                    commandWindows         = "node `"$js`""
                    statusMessage          = '加载记忆索引'
                    timeout                = 10
                    additionalContextLimit = 0
                })
            })
        }
    }) $js
}

if ($Cursor) {
    Link-One (Join-Path $HomeDir '.cursor\skills') (Join-Path $main 'skills')
    Link-One (Join-Path $HomeDir '.cursor\agents') (Join-Path $main 'agents')
    # Cursor 不读用户级的 AGENTS.md，全局规则和记忆索引都靠 sessionStart hook 注入。
    # hooks.json 要是普通文件：从家目录打开 Cursor 时，它不加载软链形态的 hooks.json
    $js = Join-Path $HomeDir '.cursor\hooks\session_start.js'
    Copy-One (Join-Path $Root 'hooks\cursor-session-start.js') $js -Refresh:$Update
    Write-HookJson (Join-Path $HomeDir '.cursor\hooks.json') ([ordered]@{
        version = 1
        hooks   = [ordered]@{
            sessionStart = @([ordered]@{ command = "node `"$($js -replace '\\', '/')`""; timeout = 10 })
        }
    }) $js
}
