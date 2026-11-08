# 给 Claude Code、Codex 的本地配置做一份快照，放进云盘的备份目录或移动硬盘。可反复运行，用 robocopy /MIR 刷新。
# 只支持 Windows。
#
# 快照里有登录凭据、完整会话记录和记忆，只能放私有位置。脚本拒绝写进任何 Git 仓库和本仓库目录。
# 软链不复制（都指向 ~/.claude，它本身会备份），只把清单写进 links-*.txt，恢复时重跑 install.ps1 重建。
# /MIR 只作用于 <Destination>\<配置目录名>，会删掉那里多出来的文件，Destination 请用专门的空目录。

param(
    [Parameter(Mandatory)][string]$Destination,
    # 家目录下的配置目录名，只能是一层名字
    [string[]]$ConfigDirs = @('.claude', '.codex'),
    # 要导出的计划任务名
    [string[]]$ScheduledTasks = @(),
    # 同时导出 HKCU\Environment。用户环境变量里常有密钥，默认不导
    [switch]$IncludeUserEnv,
    [string]$HomeDir = $HOME
)

$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$Path) {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path).TrimEnd('\', '/')
}
function Test-Under([string]$Path, [string]$Dir) {
    ($Path.TrimEnd('\') + '\').StartsWith($Dir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

# 路径按字符串比较，所以先挡掉 Windows 会当成别名的写法：结尾带点或空格的目录名，以及路径上的软链和 junction
function Assert-PlainPath([string]$Path, [string]$What) {
    foreach ($part in ($Path -split '\\' | Select-Object -Skip 1)) {
        if ($part -match '[. ]$') { throw "${What}里的目录名不能以点或空格结尾：$Path" }
    }
    for ($p = $Path; $p; $p = Split-Path $p -Parent) {
        $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        if ($item -and $item.LinkType) { throw "${What}经过软链或 junction（$p），请直接写真实路径" }
    }
}

$Destination = Get-FullPath $Destination
$HomeDir = Get-FullPath $HomeDir

# 先把所有检查做完，再动文件
foreach ($dir in $ConfigDirs) {
    if ($dir -notmatch '^[^\\/:*?"<>|]*[^\\/:*?"<>|. ]$' -or $dir.Trim('.') -eq '') { throw "配置目录名只能是一层名字，不能以点或空格结尾：$dir" }
}
Assert-PlainPath $Destination '目的地'
# 实际写入的是目的地下的这些子目录，它们自己是 junction 时也会顺着写到别处
foreach ($sub in @($ConfigDirs) + 'home', 'tasks') { Assert-PlainPath (Join-Path $Destination $sub) '目的地' }
foreach ($dir in $ConfigDirs) { Assert-PlainPath (Join-Path $HomeDir $dir) '源目录' }
if (Test-Under $Destination (Split-Path $PSScriptRoot -Parent)) { throw "目的地在本仓库目录里，快照会被误提交，换一个位置" }
for ($p = $Destination; $p; $p = Split-Path $p -Parent) {
    if (Test-Path -LiteralPath (Join-Path $p '.git')) { throw "目的地在 Git 仓库 $p 里，快照会被误提交，换一个位置" }
}
foreach ($dir in $ConfigDirs) {
    $src = Join-Path $HomeDir $dir
    $dst = Join-Path $Destination $dir
    if ((Test-Under $dst $src) -or (Test-Under $src $dst)) { throw "源目录和目的目录重叠：$src、$dst" }
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$skipDirs = 'cache', 'paste-cache', 'shell-snapshots', 'session-env', '.tmp', 'tmp'
$report = @()
$failed = $false

function Step([string]$Name, [scriptblock]$Action) {
    try { & $Action }
    catch {
        $script:failed = $true
        $script:report += "$Name 失败：$($_.Exception.Message)"
    }
}

foreach ($dir in $ConfigDirs) {
    $src = Join-Path $HomeDir $dir
    if (-not (Test-Path -LiteralPath $src)) { $report += "$dir 不存在，跳过"; continue }

    # /A-:SH 去掉隐藏和系统属性：带这两个属性的快照目录，云盘客户端可能不上传
    robocopy $src (Join-Path $Destination $dir) /MIR /XJD /XJF /A-:SH /R:1 /W:1 /MT:16 /NFL /NDL /NP /NJH /XD $skipDirs | Out-Null
    $code = $LASTEXITCODE
    # robocopy 退出码小于 8 都算成功，1 和 3 表示复制了文件
    if ($code -ge 8) { $failed = $true }
    $report += "{0,-10} robocopy exit {1}" -f $dir, $code

    Step "$dir 软链清单" {
        $links = @(Get-ChildItem -LiteralPath $src -Force -Recurse -Depth 2 |
            Where-Object { $_.LinkType } |
            ForEach-Object { "{0}`t{1}`t{2}" -f $_.FullName, $_.LinkType, ($_.Target -join ';') })
        Set-Content -Encoding utf8 -LiteralPath (Join-Path $Destination ("links-{0}.txt" -f $dir.TrimStart('.'))) -Value $links
    }
}

$claudeJson = Join-Path $HomeDir '.claude.json'
if (Test-Path -LiteralPath $claudeJson) {
    Step '.claude.json' {
        $homeDst = Join-Path $Destination 'home'
        New-Item -ItemType Directory -Force -Path $homeDst | Out-Null
        Copy-Item -LiteralPath $claudeJson -Destination $homeDst -Force
        attrib -h -s (Join-Path $homeDst '.claude.json')
        if ($LASTEXITCODE -ne 0) { throw "attrib exit $LASTEXITCODE" }
    }
}

if ($IncludeUserEnv) {
    reg export 'HKCU\Environment' (Join-Path $Destination 'env-user.reg') /y | Out-Null
    if ($LASTEXITCODE -ne 0) { $failed = $true }
    $report += "env export exit $LASTEXITCODE"
}

if ($ScheduledTasks.Count -gt 0) {
    $taskDst = Join-Path $Destination 'tasks'
    New-Item -ItemType Directory -Force -Path $taskDst | Out-Null
    foreach ($task in $ScheduledTasks) {
        Step "task $task" {
            $xml = Export-ScheduledTask -TaskName $task
            Set-Content -Encoding unicode -LiteralPath (Join-Path $taskDst "$task.xml") -Value $xml
        }
    }
}

Step 'last-run.txt' {
    Set-Content -Encoding utf8 -LiteralPath (Join-Path $Destination 'last-run.txt') `
        -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "`r`n" + ($report -join "`r`n"))
}
$report
exit $(if ($failed) { 1 } else { 0 })
