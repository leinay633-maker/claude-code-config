# 预热：给每个 Claude 订阅号用 claude -p 发一句短话、给 Codex 用 codex exec 发一句，提前开起 5 小时窗口，
# 让窗口按固定时刻滚动。由计划任务 claude-warmup 每天定时调用（Windows PowerShell 5.1），也可以手动跑：
#   warmup.ps1 -Accounts a          只预热主号
#   warmup.ps1 -Accounts codex -Force   Codex 不看旧窗口、立刻发
# 账号默认取额度看板的 accounts.json（没装看板就只有主号 a），装了 Codex 再加上 codex。
# 结果写进同目录的 warmup.log；装了看板时再写一份 warmup-<号>.js 给看板显示。
param([string[]]$Accounts = @(), [switch]$Force)

$utf8 = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
# 计划任务最多跑 30 分钟，整次运行到这个时刻就收尾，给写日志留余量
$deadline = (Get-Date).AddMinutes(27)
function Get-SecondsLeft { [int]($deadline - (Get-Date)).TotalSeconds }

# 只走官方订阅登录：清掉会让 claude、codex 改用 API key、别的接口或别的配置目录的继承变量
Get-ChildItem Env: | Where-Object { $_.Name -match '^(ANTHROPIC_|CLAUDE_CODE_USE_)' -or $_.Name -in @(
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_API_KEY_HELPER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_PROFILE', 'CODEX_CONFIG_PROFILE', 'CODEX_MANAGED_CONFIG_PATH') } |
    ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
$log = Join-Path $PSScriptRoot 'warmup.log'
$board = if ($env:CLAUDE_BOARD_DIR) { $env:CLAUDE_BOARD_DIR } else { Join-Path $env:USERPROFILE '.claude\board' }
$hasBoard = Test-Path -LiteralPath $board

function Find-Command([string[]]$Names) {
  $c = Get-Command $Names -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $c.Source } else { $null }
}
$claude = Find-Command 'claude.cmd', 'claude.exe'
$node = Find-Command 'node.exe'
# npm 装的 Codex 直接用 node 跑 codex.js：经 .cmd 包装传参容易出错；原生安装的就用 codex.exe
$codexCmd = Find-Command 'codex.cmd'
$codexJs = if ($codexCmd) { Join-Path (Split-Path $codexCmd -Parent) 'node_modules\@openai\codex\bin\codex.js' } else { $null }
if ($codexJs -and -not (Test-Path -LiteralPath $codexJs)) { $codexJs = $null }
$codexExe = Find-Command 'codex.exe'

if ($Accounts.Count -eq 0) {
  $Accounts = @('a')
  $list = Join-Path $board 'accounts.json'
  if (Test-Path -LiteralPath $list) {
    try { $Accounts = @((Get-Content -Raw -Encoding UTF8 $list | ConvertFrom-Json).accounts | ForEach-Object { $_.id }) } catch {}
  }
  if (($codexJs -and $node) -or $codexExe) { $Accounts += 'codex' }
}

# 当前 Codex 登录账号的指纹，和看板 board-config.js 的 key 同一算法；看板只把指纹对得上的预热记账算进当前账号
function Get-CodexAccountKey {
  try {
    $id = (Get-Content -Raw -Encoding UTF8 (Join-Path $env:CODEX_HOME 'auth.json') | ConvertFrom-Json).tokens.account_id
    if (-not $id) { return '' }
    $sha = [Security.Cryptography.SHA256]::Create()
    (-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$id)) | ForEach-Object { $_.ToString('x2') })).Substring(0, 24)
  } catch { '' }
}

function Format-Local([long]$sec) { [DateTimeOffset]::FromUnixTimeSeconds($sec).LocalDateTime.ToString('HH:mm') }
function Get-Now { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

# 预热不落盘（--ephemeral），看板从会话记录里算不到这笔，记进看板的 codex-ledger.log。
# 别的进程同时追加可能撞上，重试几次；还是失败就写进 warmup.log，不悄悄丢掉
function Add-LedgerRow([string]$row) {
  if (-not $hasBoard) { return }
  $file = Join-Path $board 'codex-ledger.log'
  $err = ''
  for ($i = 1; $i -le 5; $i++) {
    try { [IO.File]::AppendAllText($file, $row, $utf8); return } catch { $err = $_.Exception.Message; Start-Sleep -Milliseconds (300 * $i) }
  }
  [IO.File]::AppendAllText($log, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  codex  账本写入失败（$err），漏记：$($row.Trim())`r`n", $utf8)
}

# 读 Codex 的 5 小时窗口（只读、不耗额度），靠看板的 codex-snapshot.js；没装看板或读不到返回 $null
function Get-CodexFiveHour {
  $snap = Join-Path $board 'codex-snapshot.js'
  if (-not $node -or -not (Test-Path -LiteralPath $snap)) { return $null }
  try {
    $raw = (& $node $snap --raw 2>$null) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    $j = $raw | ConvertFrom-Json
  } catch { return $null }
  foreach ($w in @($j.rateLimits.primary, $j.rateLimits.secondary)) {
    if ($w -and $w.windowDurationMins -eq 300) { return $w }
  }
  return $null
}

# Codex 的 5 小时窗口从第一次请求那一秒算起，定时触发又有随机推迟，常落在上一个窗口的尾巴里、开不出新窗口。
# 所以发之前先读一次：旧窗口 20 分钟内结束就等它结束再发；还要更久、而且已经有用量，说明是实际使用开的窗口，这次跳过。
# 等待上限要和计划任务的 30 分钟执行上限一起算。返回 $null 表示直接发；skip=$true 表示不发；note 写进日志
function Wait-CodexWindow {
  $w = Get-CodexFiveHour
  if (-not $w) { return @{ note = '没读到 5 小时窗口，照常发' } }
  $now = Get-Now
  $reset = [long]$w.resetsAt
  if ($reset -le $now) { return $null }
  $left = $reset - $now
  if ($left -le 1200) {
    # 等完还要留约 7 分钟给两次发送（各最多 180 秒）和发完后的确认
    if ($left + 60 + 420 -gt (Get-SecondsLeft)) { return @{ skip = $true; note = "旧窗口 $(Format-Local $reset) 结束时任务已快到时限，这次跳过" } }
    Start-Sleep -Seconds ($left + 60)
    return @{ note = "等旧窗口 $(Format-Local $reset) 结束后发" }
  }
  # 用量 0% 可能是空闲时给的假重置时间，照常发（最多白发一次）
  if ([int]$w.usedPercent -eq 0) { return $null }
  return @{ skip = $true; note = "5 小时窗口 $(Format-Local $reset) 才结束（已用 $($w.usedPercent)%），这次跳过" }
}

# 发完再读一次，确认窗口真的开了、几点结束。新窗口从请求到达那一秒算，差 5 分钟以内都算这次开的；
# 额度接口可能慢半拍，没看到就隔 15 秒再读一次
function Get-CodexWindowAfter([long]$t0) {
  $w = $null
  for ($i = 0; $i -lt 2; $i++) {
    if ($i) { Start-Sleep -Seconds 15 }
    $w = Get-CodexFiveHour
    if (-not $w) { continue }
    $reset = [long]$w.resetsAt
    if ($reset -le (Get-Now)) { continue }
    if ([Math]::Abs($reset - $t0 - 18000) -le 300) { return @{ note = "开出新窗口，$(Format-Local $reset) 结束" } }
    return @{ note = "落在已有窗口里，$(Format-Local $reset) 结束" }
  }
  if (-not $w) { return @{ note = '发完没读到窗口' } }
  return @{ bad = $true; note = '发了但 5 小时窗口没开' }
}

# Codex 用最便宜的 luna、low 档；容量满就隔 30 秒换 terra 再试一次
function Invoke-CodexWarmup {
  # 每次用自己的临时目录：手动测试和计划任务撞上时共用一个目录会互删
  $work = Join-Path $env:TEMP ('codex-warmup-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force $work | Out-Null
  try {
    $prompt = Join-Path $work 'prompt.txt'
    [IO.File]::WriteAllText($prompt, 'hi', $utf8)
    $r = $null
    foreach ($model in 'gpt-6-luna', 'gpt-6.1-terra') {
      if ($r) { Start-Sleep -Seconds 30 }
      $reply = Join-Path $work 'reply.txt'
      $errf = Join-Path $work 'stderr.txt'
      $outf = Join-Path $work 'stdout.txt'
      Remove-Item $reply, $errf, $outf -ErrorAction SilentlyContinue
      $cli = "exec --json --skip-git-repo-check --ephemeral -s read-only -C `"$work`" -m $model -c model_provider=openai -c forced_login_method=chatgpt -c model_reasoning_effort=low -c web_search=disabled -o `"$reply`" -"
      if ($codexJs -and $node) { $exe = $node; $argList = "`"$codexJs`" $cli" } else { $exe = $codexExe; $argList = $cli }
      $p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -PassThru -RedirectStandardInput $prompt -RedirectStandardOutput $outf -RedirectStandardError $errf
      $null = $p.Handle  # 5.1 里不先取句柄，进程退出后拿不到 ExitCode
      if (-not $p.WaitForExit(180000)) {
        & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
        return @{ status = 'timeout'; out = "$model timeout 180s"; msg = "$model 超时 180 秒" }
      }
      $text = ''
      if (Test-Path $reply) { $text = ([string](Get-Content -Raw -Encoding UTF8 $reply) -replace '\s+', ' ').Trim() }
      $err = ''
      if (Test-Path $errf) { $err = [string](Get-Content -Raw -Encoding UTF8 $errf) }
      # --json 时 stdout 是事件流：用量在 turn.completed，报错在 turn.failed / error 事件里
      $events = @()
      if (Test-Path $outf) { $events = @(Get-Content -Encoding UTF8 $outf | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} }) }
      $usage = ($events | Where-Object { $_.type -eq 'turn.completed' } | Select-Object -Last 1).usage
      $fail = $events | Where-Object { $_.type -eq 'turn.failed' -or $_.type -eq 'error' } | Select-Object -Last 1
      $errLine = ''
      if ($fail) { $errLine = if ($fail.error) { [string]$fail.error.message } else { [string]$fail.message } }
      if (-not $errLine) { $errLine = [string]((($err -split "`r?`n") | Where-Object { $_ -match 'error' } | Select-Object -Last 1)) }
      $errLine = ($errLine -replace '\s+', ' ').Trim()
      $err = "$err $errLine"
      if ($usage) {
        Add-LedgerRow ("{0}`twarmup`t{1}`t{2}`t{3}`t{4}`t{5}`r`n" -f (Get-Now), $model, [long]$usage.input_tokens, [long]$usage.cached_input_tokens, [long]$usage.output_tokens, (Get-CodexAccountKey))
      }
      if ($p.ExitCode -eq 0 -and $text) { $status = 'ok'; $msg = $text }
      elseif ($err -match 'usage limit|hit your .*limit') { $status = 'limit'; $msg = $errLine }
      else { $status = 'error'; $msg = $errLine }
      $r = @{ status = $status; out = "$model exit=$($p.ExitCode) $msg"; msg = $msg }
      if ($status -ne 'error' -or $err -notmatch 'at capacity') { return $r }
    }
    return $r
  } finally { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}

foreach ($a in $Accounts) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  if ($a -eq 'codex') {
    if (-not (($codexJs -and $node) -or $codexExe)) { $r = @{ status = 'error'; out = '找不到 codex 命令'; msg = '找不到 codex 命令' } }
    else {
      $gate = $null
      if (-not $Force) { $gate = Wait-CodexWindow }
      if ($gate -and $gate.skip) { $r = @{ status = 'skip'; out = $gate.note; msg = $gate.note } }
      else {
        $sw = [Diagnostics.Stopwatch]::StartNew()  # 日志里的秒数只算发送本身，不算等旧窗口
        $t0 = Get-Now
        $r = Invoke-CodexWarmup
        $notes = @()
        if ($gate) { $notes += $gate.note }
        if ($r.status -eq 'ok') {
          $after = Get-CodexWindowAfter $t0
          if ($after.bad) { $r.status = 'error' }
          $notes += $after.note
        }
        # 说明放在模型回复前面：日志每行只留 160 字，放后面会被截掉
        if ($notes.Count) { $r.out = (@($notes) + $r.out) -join ' · '; $r.msg = (@($notes) + $r.msg) -join ' · ' }
      }
    }
    $out = $r.out; $status = $r.status; $msg = $r.msg
  }
  elseif (-not $claude) {
    $out = '找不到 claude 命令'; $status = 'error'; $msg = $out
  }
  else {
    $claudeArgs = @('-p', 'hi', '--model', 'haiku', '--no-session-persistence')
    # 主号不能设 CLAUDE_CONFIG_DIR：设了 Claude Code 会去配置目录里找登录态，主号的在 ~/.claude.json
    if ($a -eq 'a') { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
    else {
      $dir = Join-Path $env:USERPROFILE ".claude-$a"
      $env:CLAUDE_CONFIG_DIR = $dir
      $acct = Join-Path $dir 'account-settings.json'
      if (Test-Path $acct) { $claudeArgs = @('--settings', $acct) + $claudeArgs }
    }
    $timeout = [Math]::Min(180, (Get-SecondsLeft) - 60)
    if ($timeout -lt 30) {
      $out = '任务快到时限，跳过'; $status = 'skip'; $msg = $out
      [IO.File]::AppendAllText($log, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $a  0s  $out`r`n", $utf8)
      continue
    }
    $job = Start-Job { param($exe, $argv) [Console]::OutputEncoding = [Text.Encoding]::UTF8; & $exe @argv 2>&1 | Out-String; "exit=$LASTEXITCODE" } -ArgumentList $claude, $claudeArgs
    $timedOut = $false
    if (Wait-Job $job -Timeout $timeout) { $out = (Receive-Job $job) -join ' ' } else { Stop-Job $job; $out = "timeout ${timeout}s"; $timedOut = $true }
    Remove-Job $job -Force
    $out = ($out -replace '\s+', ' ').Trim()
    # 截断前判结果：日志只留前 160 字，exit 码常被挤掉
    $status = if ($timedOut) { 'timeout' }
      elseif ($out -match 'hit your .*limit') { 'limit' }
      elseif ($out -notmatch 'exit=0$') { 'error' }
      else { 'ok' }
    # 去掉 SessionEnd hook 的取消提示（-p 退出时会报，无影响）和末尾的退出码
    $msg = ($out -replace '(claude\.(cmd|exe) : )?SessionEnd hook.*$', '' -replace '\s*exit=-?\d+$', '').Trim()
  }
  if ($msg.Length -gt 160) { $msg = $msg.Substring(0, 160) }
  if ($out.Length -gt 160) { $out = $out.Substring(0, 160) }
  [IO.File]::AppendAllText($log, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $a  $([int]$sw.Elapsed.TotalSeconds)s  $out`r`n", $utf8)

  if ($hasBoard) {
    # 看板每个号读一份，写法同 acct-<号>.js。alive 是最近一次证明订阅还在的时间（正常回复，或报额度已满：
    # 只有付费号才有额度上限），看板按它顺延订阅到期日；这次没跑通就沿用上次的，免得偶尔失败一次就显示成已到期
    $wfile = Join-Path $board "warmup-$a.js"
    $stamp = Get-Now
    $alive = $null
    if ($status -eq 'ok' -or $status -eq 'limit') { $alive = $stamp }
    elseif ((Test-Path $wfile) -and ([IO.File]::ReadAllText($wfile) -match '"alive":(\d+)')) { $alive = [long]$Matches[1] }
    $info = @{ at = $stamp; status = $status; msg = $msg }
    if ($alive) { $info.alive = $alive }
    [IO.File]::WriteAllText($wfile, "(window.WARMUP=window.WARMUP||{})[`"$a`"]=$(ConvertTo-Json -Compress $info);`r`n", $utf8)
  }
}
Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
