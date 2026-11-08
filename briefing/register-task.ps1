[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'ai-briefing',
    [string]$Time = $(if ($env:AI_BRIEFING_TIME) { $env:AI_BRIEFING_TIME } else { '09:30' }),
    [AllowEmptyString()][string]$RetryTime = $(if (Test-Path Env:AI_BRIEFING_RETRY_TIME) { $env:AI_BRIEFING_RETRY_TIME } else { '14:30' }),
    [string]$Python = $(if ($env:AI_BRIEFING_PYTHON) { $env:AI_BRIEFING_PYTHON } else { 'python' }),
    [string]$OutputDir = $(if ($env:AI_BRIEFING_OUTPUT_DIR) { $env:AI_BRIEFING_OUTPUT_DIR } else { Join-Path $env:USERPROFILE 'AI-Briefing' }),
    [string]$BoardDir = $(if ($env:AI_BRIEFING_BOARD_DIR) { $env:AI_BRIEFING_BOARD_DIR } else { Join-Path $env:USERPROFILE '.claude\board' }),
    [string]$PromptFile = $(if ($env:AI_BRIEFING_PROMPT_FILE) { $env:AI_BRIEFING_PROMPT_FILE } else { Join-Path $PSScriptRoot 'prompt.md' }),
    [string]$ClaudeModel = $(if ($env:AI_BRIEFING_CLAUDE_MODEL) { $env:AI_BRIEFING_CLAUDE_MODEL } else { 'claude-opus-5-5' }),
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$ClaudeEffort = $(if ($env:AI_BRIEFING_CLAUDE_EFFORT) { $env:AI_BRIEFING_CLAUDE_EFFORT } else { 'max' }),
    [string]$CodexModel = $(if ($env:AI_BRIEFING_CODEX_MODEL) { $env:AI_BRIEFING_CODEX_MODEL } else { 'gpt-6.1-sol' }),
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$CodexEffort = $(if ($env:AI_BRIEFING_CODEX_EFFORT) { $env:AI_BRIEFING_CODEX_EFFORT } else { 'high' }),
    [switch]$Web,
    [switch]$NoWeb,
    [switch]$NoCodex
)

$ErrorActionPreference = 'Stop'
$owner = 'claude-code-config/briefing:v1'

function Get-BoolSetting([string]$Name, [bool]$Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $value -or $value -eq '') { return $Default }
    switch ($value.ToLowerInvariant()) {
        { $_ -in '1', 'true', 'yes', 'on' } { return $true }
        { $_ -in '0', 'false', 'no', 'off' } { return $false }
        default { throw "$Name 应为 true 或 false" }
    }
}

function Resolve-BriefingPath([string]$Value) {
    if ($Value -eq '~') { return $env:USERPROFILE }
    if ($Value -match '^~[\\/]') { $Value = Join-Path $env:USERPROFILE $Value.Substring(2) }
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Value)
}

function Quote-ScriptHostArgument([string]$Value) {
    # 脚本宿主按引号分词，反斜杠不会像 Python 的命令行解析器那样被转义。
    if ($Value -match '["\x00\r\n]') { throw '参数中不能包含双引号或控制字符' }
    return '"' + $Value + '"'
}

if ($Web -and $NoWeb) { throw '-Web 与 -NoWeb 不能同时使用' }
foreach ($clock in @($Time, $RetryTime)) {
    if ($clock -eq '' -and $clock -eq $RetryTime) { continue }
    if ($clock -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$') { throw '时间必须使用 HH:mm 格式' }
}
if (-not $Time) { throw 'Time 不能为空' }
if ($TaskName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'TaskName 只能包含字母、数字、点、下划线和连字符' }
foreach ($model in @($ClaudeModel, $CodexModel)) {
    if ($model -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw '模型名格式无效' }
}

$launcher = Join-Path $PSScriptRoot 'briefing-hidden.vbs'
$script = Join-Path $PSScriptRoot 'briefing.py'
$PromptFile = Resolve-BriefingPath $PromptFile
foreach ($file in @($launcher, $script, $PromptFile)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "找不到文件：$file" }
}

$existing = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq $TaskName })
if ($existing.Count -gt 0) {
    $current = $existing[0]
    $expectedPrefix = (Quote-ScriptHostArgument $launcher) + ' '
    if ($current.Description -notlike "$owner*" -or @($current.Actions).Count -ne 1 -or
        -not ([string]$current.Actions[0].Arguments).StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "已有同名任务 '$TaskName'，且不属于此安装目录；请使用 -TaskName 指定新名称"
    }
}

$pythonCommand = Get-Command -Name $Python -CommandType Application -ErrorAction Stop | Select-Object -First 1
$resolvedPython = @(& $pythonCommand.Source -X utf8 -c 'import sys; print(sys.executable)')
if ($LASTEXITCODE -ne 0 -or $resolvedPython.Count -ne 1) { throw 'Python 无法运行' }
$resolvedPython = $resolvedPython[0].Trim()
if (-not (Test-Path -LiteralPath $resolvedPython -PathType Leaf)) { throw 'Python 入口无效' }
$OutputDir = Resolve-BriefingPath $OutputDir
$BoardDir = Resolve-BriefingPath $BoardDir
$webEnabled = Get-BoolSetting 'AI_BRIEFING_WEB' $false
if ($Web) { $webEnabled = $true }
if ($NoWeb) { $webEnabled = $false }
$codexEnabled = (Get-BoolSetting 'AI_BRIEFING_CODEX' $true) -and -not $NoCodex

$nativeArgs = @($launcher, $resolvedPython, '--output-dir', $OutputDir, '--board-dir', $BoardDir,
    '--prompt-file', $PromptFile, '--claude-model', $ClaudeModel, '--claude-effort', $ClaudeEffort,
    '--codex-model', $CodexModel, '--codex-effort', $CodexEffort)
$nativeArgs += $(if ($webEnabled) { '--web' } else { '--no-web' })
$nativeArgs += $(if ($codexEnabled) { '--codex' } else { '--no-codex' })
$arguments = ($nativeArgs | ForEach-Object { Quote-ScriptHostArgument $_ }) -join ' '
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument $arguments -WorkingDirectory $PSScriptRoot
$triggers = @($Time, $RetryTime) | Where-Object { $_ } | Select-Object -Unique | ForEach-Object {
    New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.Add([TimeSpan]::ParseExact($_, 'hh\:mm', [Globalization.CultureInfo]::InvariantCulture)))
}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$definition = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description "$owner 每日 AI 简报，按本地时间运行；安装目录：$PSScriptRoot"

if ($PSCmdlet.ShouldProcess($TaskName, "注册每日任务（本地 $Time，补跑 $RetryTime）")) {
    $registration = @{ TaskName = $TaskName; TaskPath = '\'; InputObject = $definition; ErrorAction = 'Stop' }
    if ($existing.Count -gt 0) { $registration.Force = $true }
    Register-ScheduledTask @registration | Out-Null
    Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\' | Select-Object TaskName, NextRunTime
}
