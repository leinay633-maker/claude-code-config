# Stop hook: the turn finished, so light up the tab's done indicator while
# keeping whatever title the LLM half produced.
#
# Reads the cached title rather than regenerating it -- no model call here.
# Must print NOTHING to stdout.

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'tab-title-lib.ps1')

try {
    # Drain stdin so the hook doesn't block on the pipe. Also inspect it:
    # Stop fires on /clear too, and would otherwise re-paint the previous title.
    $raw = ''
    try {
        $stdin = [Console]::OpenStandardInput()
        $sr = New-Object IO.StreamReader($stdin, [Text.Encoding]::UTF8)
        $raw = $sr.ReadToEnd()
        $sr.Close()
    } catch { }

    # Stop on /clear has no source field; the reset flag is what SessionStart /
    # UserPromptSubmit raise. Re-stamp the profile name instead of the cache.
    if (Test-TabTitleResetFlag) {
        Reset-TabTitleToProfile
        exit 0
    }

    Set-TabTitleDoneGen (Get-TabTitleGen)

    $title = Get-TabTitleState
    if (-not $title) { exit 0 }

    [void](Write-TabTitle -Text $title -State done -NoCache)
    # The LLM child may have cached a new short title between our read and
    # write; repaint with it so the interim title doesn't win.
    $latest = Get-TabTitleState
    if ($latest -and $latest -ne $title) {
        [void](Write-TabTitle -Text $latest -State done -NoCache)
    }
} catch { }

exit 0
