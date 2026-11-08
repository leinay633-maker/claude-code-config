# PowerShell 7 的命令行设置。install.ps1 -Shell 把它复制到 ~/.claude/shell/profile.ps1，再从 $PROFILE 加载。

# 控制台默认按系统代码页收发，中文会乱
chcp 65001 > $null
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Test-ProxyAlive {
  param([string]$ProxyHost = '127.0.0.1', [int]$Port = 7897, [int]$TimeoutMs = 300)
  try {
    $c = New-Object Net.Sockets.TcpClient
    $ok = $c.ConnectAsync($ProxyHost, $Port).Wait($TimeoutMs)
    $c.Close()
    return $ok
  } catch { return $false }
}

# 默认端口是 Clash Verge 的 7897，别的代理软件用 proxy-on http://127.0.0.1:端口
function proxy-on {
  param(
    [string]$Proxy = 'http://127.0.0.1:7897',
    [switch]$Quiet,
    [switch]$Force
  )

  # 代理没在听就别设：死端口会让所有出网请求失败得比直连更难查
  if (-not $Force) {
    $u = [Uri]$Proxy
    if (-not (Test-ProxyAlive -ProxyHost $u.Host -Port $u.Port)) {
      Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
      Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
      Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
      Write-Host "Proxy $Proxy 没有在监听，已保持直连。确实要设置请加 -Force。" -ForegroundColor Yellow
      return
    }
  }

  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  $env:ALL_PROXY = $Proxy
  $env:NO_PROXY = 'localhost,127.0.0.1,::1,.local'

  if (-not $Quiet) { Write-Host "Proxy on: $Proxy" }
}

function proxy-off {
  Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue
  Write-Host 'Proxy off'
}

function proxy-status {
  [PSCustomObject]@{
    HTTP_PROXY  = $env:HTTP_PROXY
    HTTPS_PROXY = $env:HTTPS_PROXY
    ALL_PROXY   = $env:ALL_PROXY
    NO_PROXY    = $env:NO_PROXY
  }
}

# 清掉从父进程继承来的死代理。指向无人监听端口的 HTTPS_PROXY 会让所有出网请求失败（含 Claude Code 的 WebFetch 域名预检），
# 表现为 "Unable to verify if domain ... is safe to fetch"，很容易误判成别的问题。
if ($env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:ALL_PROXY) {
  $__p = $env:HTTPS_PROXY, $env:HTTP_PROXY, $env:ALL_PROXY | Where-Object { $_ } | Select-Object -First 1
  $__dead = $true
  try {
    $__u = [Uri]$__p
    $__dead = -not (Test-ProxyAlive -ProxyHost $__u.Host -Port $__u.Port)
  } catch { $__dead = $true }

  if ($__dead) {
    Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
    Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
    Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
    if (-not [Console]::IsOutputRedirected) {
      Write-Host "继承的代理 $__p 无人监听，已清除并走直连。" -ForegroundColor DarkYellow
    }
  }
  Remove-Variable __p, __dead, __u -ErrorAction SilentlyContinue
}

# Starship 提示符，配置在 ~/.config/starship.toml
$__starship = (Get-Command starship -ErrorAction Ignore).Source
if (-not $__starship) {
  # winget 刚装完、PATH 还没生效的会话里兜底
  $__fallback = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Starship.Starship_Microsoft.Winget.Source_8wekyb3d8bbwe\starship.exe"
  if (Test-Path $__fallback) { $__starship = $__fallback }
}
if ($__starship) {
  $env:STARSHIP_CONFIG = "$HOME\.config\starship.toml"
  Invoke-Expression (& $__starship init powershell)
}
Remove-Variable __starship, __fallback -ErrorAction SilentlyContinue

# 历史预测和上下键按前缀搜历史。预测要虚拟终端，输出被重定向时跳过，免得非交互场景报错
if ((Get-Module -ListAvailable PSReadLine) -and -not [Console]::IsOutputRedirected) {
  Set-PSReadLineOption -PredictionSource History
  Set-PSReadLineOption -PredictionViewStyle ListView
  Set-PSReadLineOption -EditMode Windows
  Set-PSReadLineKeyHandler -Key UpArrow -Function HistorySearchBackward
  Set-PSReadLineKeyHandler -Key DownArrow -Function HistorySearchForward
  # Catppuccin Mocha，和 Windows Terminal、Starship 一套
  Set-PSReadLineOption -Colors @{
    Command   = '#89b4fa'
    Parameter = '#94e2d5'
    Operator  = '#f5c2e7'
    Variable  = '#f9e2af'
    String    = '#a6e3a1'
    Number    = '#fab387'
    Type      = '#cba6f7'
    Comment   = '#6c7086'
    Keyword   = '#cba6f7'
    Error     = '#f38ba8'
  }
}
