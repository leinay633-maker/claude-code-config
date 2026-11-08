# codex-agent：用 Codex CLI 跑一个独立子代理（默认 gpt-6.1-sol、max），走 ~/.codex 的官方登录（ChatGPT 订阅），不花 Claude 额度。
# 输出子代理的最终报告，末行写模型、用时、token、会话 ID 和全文路径。
# 只读模式只靠提示词约束：Codex 的 Windows 沙箱不是每台机器都能用，这里关掉沙箱。
param(
  [Parameter(Mandatory)][string]$PromptFile,
  [string]$Cwd = (Get-Location).Path,
  [ValidateSet('read', 'write')][string]$Mode = 'read',
  # 复用 ~/.claude/agents/<名>.md 的正文（Codex 不支持限定工具列表）
  [string]$Agent,
  [string[]]$AddDir = @(),
  # 追问之前的会话
  [string]$Resume,
  [string]$Model = 'gpt-6.1-sol',
  [string]$Effort = 'max',
  [string]$OutDir = (Join-Path $env:TEMP 'codex-agent')
)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8
[Console]::OutputEncoding = $utf8

# 只走官方订阅登录：清掉会让 codex 改用 API key、别的接口或别的配置目录的继承变量，下面再用 -c 固定 provider 和登录方式
foreach ($name in 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_PROFILE', 'CODEX_CONFIG_PROFILE', 'CODEX_MANAGED_CONFIG_PATH') {
  Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'

New-Item -ItemType Directory -Force $OutDir | Out-Null
# 同一秒并发起多个时文件名会撞，加随机后缀
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)

$memory = Join-Path $env:USERPROFILE '.claude\memory'
$system = @('你是主会话派出的子代理，独立做完任务后用简体中文写最终报告。主会话只看得到你最后一条回复，结论、文件路径、行号和原文摘录都要写进这条回复。',
  "你自己不再派子代理（不调用 codex-agent 或 run-codex.ps1），也不改记忆目录 $memory；任务要求运行的测试脚本照常运行。")
if ($Agent) {
  $definition = Get-Content -Raw -Encoding utf8 (Join-Path $env:USERPROFILE ".claude\agents\$Agent.md")
  if ($definition -match '(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$') { $system += $Matches[1].Trim() }
  else { $system += $definition.Trim() }
}
if ($Mode -eq 'read') { $system += '本次只读：不创建、修改、移动或删除任何文件，终端只跑只读命令。' }
$prompt = ($system -join "`n`n") + "`n`n---- 任务 ----`n`n" + (Get-Content -Raw -Encoding utf8 $PromptFile)

$lastFile = Join-Path $OutDir "$stamp-codex-result.md"
$cliArgs = @('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
  '-C', $Cwd, '-m', $Model, '-c', 'model_provider=openai', '-c', 'forced_login_method=chatgpt',
  '-c', "model_reasoning_effort=$Effort", '-c', 'web_search=live', '-o', $lastFile)
foreach ($dir in $AddDir) { $cliArgs += @('--add-dir', $dir) }

# 会话一律留记录（可以 -Resume 追问，额度看板也按记录算 Codex 的花费和速度），跑完用 codex-archive.js 归档，
# Codex 应用里就不再列出。归档的会话不能直接 resume，追问前先 codex unarchive，问完再归档。
if ($Resume -and (Get-ChildItem (Join-Path $env:USERPROFILE '.codex\archived_sessions') -Recurse -Filter "rollout-*$Resume.jsonl" -ErrorAction SilentlyContinue)) {
  Push-Location $env:USERPROFILE  # cmd 找命令会先查当前目录
  $ErrorActionPreference = 'Continue'
  try { codex unarchive $Resume 2>&1 | Out-Null } finally { Pop-Location; $ErrorActionPreference = 'Stop' }
}
if ($Resume) { $cliArgs = @('exec') + $cliArgs + @('resume', $Resume, '-') }
else { $cliArgs = @('exec') + $cliArgs + @('-') }

$errFile = Join-Path $OutDir "$stamp-codex-stderr.log"
$sw = [Diagnostics.Stopwatch]::StartNew()
# Windows PowerShell 5.1 在 Stop 模式下会把原生命令写到 stderr 的正常诊断当成异常终止脚本，这两处调用临时放宽
$ErrorActionPreference = 'Continue'
$events = $prompt | & codex @cliArgs 2>$errFile
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$seconds = $sw.Elapsed.TotalSeconds
$parsed = @($events) | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} }

$thread = ($parsed | Where-Object type -eq 'thread.started' | Select-Object -First 1).thread_id
$completed = $parsed | Where-Object type -eq 'turn.completed' | Select-Object -Last 1
$usage = $completed.usage
# 成败只看有没有 turn.completed、退出码和结果文件；中途的 error 事件可能是自动重连，最后照样完成，只在失败时打出来
$failed = $parsed | Where-Object { $_.type -in 'turn.failed', 'error' } | Select-Object -Last 1
if (-not $thread -and $Resume) { $thread = $Resume }
$archived = ''
if ($thread) {
  $ErrorActionPreference = 'Continue'
  $archErr = & node (Join-Path $PSScriptRoot 'codex-archive.js') $thread 2>&1
  $archCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $archived = if ($archCode -eq 0) { '已归档' } else { "归档失败（$(([string]($archErr -join ' ')).Trim())）" }
}
if (-not (Test-Path $lastFile) -or -not $completed -or $code -ne 0) {
  Write-Output "codex 失败（退出码 $code）。stderr：$errFile"
  if ($thread) { Write-Output "会话 $thread $archived" }
  if ($failed) { Write-Output ($failed | ConvertTo-Json -Compress -Depth 5) }
  Get-Content -Encoding utf8 $errFile -Tail 20
  exit 1
}
$tools = $parsed | Where-Object { $_.type -eq 'item.completed' -and $_.item.type -in 'command_execution', 'web_search' }
Write-Output (Get-Content -Raw -Encoding utf8 $lastFile)
Write-Output ''
Write-Output ('---- codex-agent({0} {1})：完成，{2:N0} 秒，命令 {3} 次、搜索 {4} 次，输入 {5:N0}（缓存 {6:N0}）/ 输出 {7:N0} token，会话 {8} {9}，全文 {10}' -f `
  $Model, $Effort, $seconds, @($tools | Where-Object { $_.item.type -eq 'command_execution' }).Count, @($tools | Where-Object { $_.item.type -eq 'web_search' }).Count,
  $usage.input_tokens, $usage.cached_input_tokens, $usage.output_tokens, $thread, $archived, $lastFile)
# 显式退出 0：不然 $LASTEXITCODE 停在归档那次 node 的退出码
exit 0
