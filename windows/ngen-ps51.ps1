# 给 Windows PowerShell 5.1 常用的程序集生成本机映像，让 powershell.exe 冷启动从约 1 秒降到 0.3 秒左右。
# Claude Code 在 Windows 上每次 Alt+V 贴图、每个用 powershell.exe 跑的 hook 都要现起一个 5.1 进程，慢就慢在这里。
# .NET Framework 更新会把本机映像作废，贴图或 hook 又变慢时重跑一次。
# 用法：以管理员身份打开 Windows PowerShell（不是 pwsh），运行 .\ngen-ps51.ps1，约 1 分钟。
# 检查效果：Measure-Command { powershell -NoProfile -Command "exit 0" }，超过 0.5 秒就该重跑了。

if ($PSVersionTable.PSVersion.Major -ne 5) { throw '要用 Windows PowerShell 5.1（powershell.exe）运行，不是 pwsh。' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw '要以管理员身份运行。' }

# 先把贴图检查会用到的程序集加载进来，下面按已加载的程序集逐个生成
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[void][System.Windows.Forms.Clipboard]::ContainsImage()
Get-Clipboard | Out-Null

$ngen = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'ngen.exe'
[AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.Location } | ForEach-Object {
    & $ngen install $_.Location /nologo | Out-Null
    '{0}  {1}' -f $LASTEXITCODE, $_.GetName().Name
}
