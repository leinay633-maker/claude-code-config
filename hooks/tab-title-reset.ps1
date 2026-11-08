# SessionStart / SessionEnd hook: restore the WT profile name on /clear.
# Without this, the previous prompt's title sticks around because OSC 0 is
# sticky and /clear also fires Stop, which would re-paint the cache.
#
# Must print NOTHING to stdout -- SessionStart stdout is injected into context.
#
# Ordering is load-bearing: Write-TabTitle calls FreeConsole, which destroys
# this process's stdio. Read stdin BEFORE writing any title.

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'tab-title-lib.ps1')

try {
    $stdin = [Console]::OpenStandardInput()
    $sr = New-Object IO.StreamReader($stdin, [Text.Encoding]::UTF8)
    $raw = $sr.ReadToEnd()
    $sr.Close()
    if (-not $raw) { exit 0 }

    $evt = $raw | ConvertFrom-Json
    # SessionStart uses source=clear; SessionEnd uses reason=clear. /clear
    # fires both (End first). Other sources/reasons (startup, resume, logout)
    # must keep the current title.
    $kind = [string]$evt.source
    if (-not $kind) { $kind = [string]$evt.reason }
    if ($kind -ne 'clear') { exit 0 }

    Reset-TabTitleToProfile
} catch { }

exit 0
