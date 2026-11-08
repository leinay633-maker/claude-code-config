# UserPromptSubmit hook: set the Windows Terminal tab title from the prompt.
#
# Fast path only; the LLM rewrite happens in tab-title-llm.ps1 in the background.
# Must print NOTHING to stdout -- UserPromptSubmit stdout is injected into
# Claude's context on exit 0.
#
# Ordering is load-bearing: Write-TabTitle calls FreeConsole, which destroys this
# process's stdio. Read stdin and spawn the child BEFORE writing any title.

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'tab-title-lib.ps1')

function Clean-Title([string]$s) {
    if (-not $s) { return '' }
    $s = $s -replace '[\r\n\t]', ' '
    # Strip ESC/BEL and all control chars so the prompt can't break out of the
    # OSC sequence.
    $s = $s -replace '[\x00-\x1f\x7f]', ''
    $s = $s -replace '\s+', ' '
    return $s.Trim()
}

try {
    $stdin = [Console]::OpenStandardInput()
    $sr = New-Object IO.StreamReader($stdin, [Text.Encoding]::UTF8)
    $raw = $sr.ReadToEnd()
    $sr.Close()
    if (-not $raw) { exit 0 }

    $prompt = Clean-Title ($raw | ConvertFrom-Json).prompt
    if (-not $prompt) { exit 0 }
    # /clear (aliases: /reset, /new) is a session reset, not a task. Restore
    # the WT profile name here as well as in SessionStart/SessionEnd:
    # UserPromptSubmit is already registered in the running session, the
    # other two events may not be until CC reloads settings.
    if ($prompt -match '^/(clear|reset|new)(\s|$)') {
        Reset-TabTitleToProfile
        exit 0
    }

    # A new prompt means this tab is in use again; drop the /clear reset flag
    # so Write-TabTitle (and the LLM child) can set a title. Step the generation
    # so an in-flight LLM child from the previous prompt cannot overwrite us.
    Clear-TabTitleResetFlag
    $gen = Step-TabTitleGen

    # Resolve the tab console now, while the ancestry is intact, and hand the
    # PIDs to the child so it doesn't have to re-walk the tree.
    $pids = Get-TabConsolePids

    $short = $prompt.Length -le 10
    if (-not $short) {
        # Spawn the LLM rewrite first (needs stdio + a live process tree), then
        # set the interim title below.
        $tmp = Join-Path $env:TEMP ("cc-title-" + [Guid]::NewGuid().ToString('N') + ".txt")
        [IO.File]::WriteAllText($tmp, $prompt, (New-Object Text.UTF8Encoding($false)))

        $llm = Join-Path $PSScriptRoot 'tab-title-llm.ps1'
        # Start-Process joins -ArgumentList with spaces and quotes nothing, so
        # paths (user name, repo dir, TEMP) must carry their own quotes.
        $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$llm`"", '-PromptFile', "`"$tmp`"", '-Gen', "$gen")
        if ($pids.Count -gt 0) { $childArgs += @('-ConsolePids', ($pids -join ',')) }
        if ($script:CCTabSessionKey) { $childArgs += @('-SessionKey', "`"$($script:CCTabSessionKey)`"") }

        # Redirect the child's streams to files: with -NoNewWindow its stdout
        # would otherwise land in the hook's stdout and reach Claude's context.
        $logKey = if ($script:CCTabSessionKey) { $script:CCTabSessionKey } else { 'default' }
        Start-Process powershell.exe -NoNewWindow -ArgumentList $childArgs `
            -RedirectStandardOutput (Join-Path $env:TEMP "cc-title-child-$logKey.out.log") `
            -RedirectStandardError  (Join-Path $env:TEMP "cc-title-child-$logKey.err.log") | Out-Null
    }

    # Title write goes last: FreeConsole below invalidates stdio and the ability
    # to spawn console children.
    # No dot while busy -- the indicator only marks "done", so a bare title means
    # still running.
    if ($short) {
        [void](Write-TabTitle -Text $prompt -ConsolePids $pids)
    } else {
        $interim = $prompt.Substring(0, [Math]::Min(24, $prompt.Length)) + [char]0x2026
        [void](Write-TabTitle -Text $interim -ConsolePids $pids)
    }
} catch { }

exit 0
