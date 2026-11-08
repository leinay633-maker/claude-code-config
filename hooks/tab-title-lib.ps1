# Shared helpers for the tab-title hook.
#
# Why any of this is needed: Claude Code launches hooks through git-bash, and
# git-bash itself has NO console. Windows therefore hands the PowerShell child a
# brand-new throwaway console. Writing OSC 0 to CONOUT$ there "succeeds" and is
# never seen by Windows Terminal. The tab's real console belongs to the shell
# that WT spawned (pwsh.exe), which is an ancestor of this process, so we
# FreeConsole and AttachConsole onto it before writing.

if (-not ('CCTab.Native' -as [type])) {
Add-Type -Namespace CCTab -Name Native -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr CreateFileW(string n, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool WriteFile(IntPtr h, byte[] buf, uint n, out uint written, IntPtr ov);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)]
public static extern uint GetConsoleProcessList(uint[] list, uint count);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool SetConsoleTitle(string lpConsoleTitle);
"@
}

# Walk ancestors up to (not past) WindowsTerminal.exe and return only the PIDs
# that actually own THIS tab's console:
#   1. the shell WT spawned (parent is WindowsTerminal.exe) -- one per tab
#   2. claude.exe in the same chain, as a fallback (it shares that console)
# Walking past WT used to include ChatGPT/sihost/services; AttachConsole
# succeeding on any of those paints the title onto the wrong console, which
# is how two CC tabs could steal each other's titles.
function Get-TabConsolePids {
    try {
        $procs = @{}
        Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name |
            ForEach-Object { $procs[[uint32]$_.ProcessId] = $_ }

        $chain = @()
        $cur = [uint32]$PID
        for ($i = 0; $i -lt 20; $i++) {
            $p = $procs[$cur]
            if (-not $p) { break }
            if ($p.Name -eq 'WindowsTerminal.exe') { break }
            $chain += $p
            $cur = [uint32]$p.ParentProcessId
            if ($cur -eq 0) { break }
        }

        $shell = @($chain | Where-Object {
            $parent = $procs[[uint32]$_.ParentProcessId]
            $parent -and $parent.Name -eq 'WindowsTerminal.exe' -and
                [uint32]$_.ProcessId -ne [uint32]$PID
        } | ForEach-Object { [uint32]$_.ProcessId })

        $claude = @($chain | Where-Object {
            $_.Name -eq 'claude.exe' -and [uint32]$_.ProcessId -ne [uint32]$PID
        } | ForEach-Object { [uint32]$_.ProcessId })

        $out = @()
        foreach ($x in ($shell + $claude)) {
            if ($x -and ($out -notcontains $x)) { $out += $x }
        }
        if ($out.Count -gt 0) { return $out }

        # Not launched from WT (VS Code terminal, etc.): nearest shell/claude.
        return @($chain | Where-Object {
            $_.Name -match '^(pwsh|powershell|cmd|bash|claude)\.exe$' -and
                [uint32]$_.ProcessId -ne [uint32]$PID
        } | ForEach-Object { [uint32]$_.ProcessId })
    } catch { }
    return @()
}

# After AttachConsole, the attached console must contain at least one of OUR
# tab's PIDs. AttachConsole returns true for a sibling tab's pwsh in the same
# WT window (verified 2026-08-21: attached to the other tab and read ITS title).
# Checking the attach target is in the list is useless — of course it is.
# Checking OUR shell/claude are in the list is what stops the mix.
function Test-AttachedConsoleOwnedBy {
    param([Parameter(Mandatory = $true)][uint32[]]$OwnedPids)
    if (-not $OwnedPids -or $OwnedPids.Count -eq 0) { return $false }
    try {
        $buf = New-Object uint32[] 64
        $cnt = [CCTab.Native]::GetConsoleProcessList($buf, 64)
        if ($cnt -eq 0) { return $false }
        $n = [Math]::Min([int]$cnt, $buf.Length)
        for ($i = 0; $i -lt $n; $i++) {
            foreach ($owned in $OwnedPids) {
                if ($buf[$i] -eq $owned) { return $true }
            }
        }
    } catch { }
    return $false
}

# Done indicator uses OSC 9;4 (ConEmu progress, supported by WT since 1.6),
# which draws a ring on the tab header itself and leaves the title text clean.
# CC's own OSC 21337 indicator is dead code in current builds (its guard is
# hardcoded false) and WT doesn't implement 21337 anyway.
# State 1 = normal (Windows accent color); 0 = clear. There is no "green" state.
$script:CCTabProgressDone  = "$([char]27)]9;4;1;100$([char]7)"
$script:CCTabProgressClear = "$([char]27)]9;4;0;0$([char]7)"

# Per-tab files. Prefer WT_SESSION (unique per tab). If the hook env lost it
# (git-bash sometimes drops WT_*), fall back to the WT-spawned shell PID so
# two tabs never share cc-tab-title-state.txt — that shared file was the
# other mix path: tab B's Stop would paint tab A's cached title.
$script:CCTabSessionKey = if ($env:WT_SESSION) {
    $env:WT_SESSION
} else {
    $fallbackPids = Get-TabConsolePids
    if ($fallbackPids.Count -gt 0) { "pid-$($fallbackPids[0])" } else { "default" }
}
$script:CCTabStateFile  = Join-Path $env:TEMP "cc-tab-title-state-$($script:CCTabSessionKey).txt"
$script:CCTabResetFlag  = Join-Path $env:TEMP "cc-tab-title-reset-$($script:CCTabSessionKey).flag"
$script:CCTabGenFile    = Join-Path $env:TEMP "cc-tab-title-gen-$($script:CCTabSessionKey).txt"
$script:CCTabDoneFile   = Join-Path $env:TEMP "cc-tab-title-done-$($script:CCTabSessionKey).txt"

# Stop records which generation finished, so an LLM child that returns after
# Stop keeps the done ring instead of clearing it. A new prompt steps the
# generation, which makes the old record stale without deleting it.
function Set-TabTitleDoneGen {
    param([int]$Gen)
    try { [IO.File]::WriteAllText($script:CCTabDoneFile, "$Gen", (New-Object Text.UTF8Encoding($false))) } catch { }
}

function Test-TabTitleDone {
    param([int]$Gen)
    if (-not $Gen) { return $false }
    try {
        if (Test-Path -LiteralPath $script:CCTabDoneFile) {
            return ([int][IO.File]::ReadAllText($script:CCTabDoneFile, [Text.Encoding]::UTF8).Trim()) -eq $Gen
        }
    } catch { }
    return $false
}

function Get-TabTitleGen {
    try {
        if (Test-Path -LiteralPath $script:CCTabGenFile) {
            return [int][IO.File]::ReadAllText($script:CCTabGenFile, [Text.Encoding]::UTF8).Trim()
        }
    } catch { }
    return 0
}

# Bump so in-flight LLM children (from the previous prompt / a /clear) refuse
# to overwrite the title that now belongs to a newer generation.
function Step-TabTitleGen {
    $n = (Get-TabTitleGen) + 1
    try { [IO.File]::WriteAllText($script:CCTabGenFile, "$n", (New-Object Text.UTF8Encoding($false))) } catch { }
    return $n
}

function Set-TabTitleState {
    param([Parameter(Mandatory = $true)][string]$Title)
    try { [IO.File]::WriteAllText($script:CCTabStateFile, $Title, (New-Object Text.UTF8Encoding($false))) } catch { }
}

function Get-TabTitleState {
    try {
        if (Test-Path -LiteralPath $script:CCTabStateFile) {
            return [IO.File]::ReadAllText($script:CCTabStateFile, [Text.Encoding]::UTF8).Trim()
        }
    } catch { }
    return ''
}

function Clear-TabTitleState {
    try { if (Test-Path -LiteralPath $script:CCTabStateFile) { Remove-Item -LiteralPath $script:CCTabStateFile -Force } } catch { }
}

# Set by SessionStart(source=clear) so a racing Stop hook doesn't paint the
# previous conversation's title back onto the tab.
function Set-TabTitleResetFlag {
    try { [IO.File]::WriteAllText($script:CCTabResetFlag, '1', (New-Object Text.UTF8Encoding($false))) } catch { }
}

function Test-TabTitleResetFlag {
    try { return (Test-Path -LiteralPath $script:CCTabResetFlag) } catch { }
    return $false
}

function Clear-TabTitleResetFlag {
    try { if (Test-Path -LiteralPath $script:CCTabResetFlag) { Remove-Item -LiteralPath $script:CCTabResetFlag -Force } } catch { }
}

# Fresh-tab title: the WT profile name this tab was opened with. /clear should
# look like a brand-new CC tab, not keep the previous prompt's summary.
function Get-WtProfileName {
    $guid = $env:WT_PROFILE_ID
    if (-not $guid) { return 'PowerShell' }
    # WT_SETTINGS_DIR first when it is set, then Store stable, Store preview and
    # unpackaged installs. Portable mode keeps settings next to the exe and is
    # only found through WT_SETTINGS_DIR.
    $candidates = @()
    if ($env:WT_SETTINGS_DIR) { $candidates += Join-Path $env:WT_SETTINGS_DIR 'settings.json' }
    $candidates += @(
        'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json',
        'Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json',
        'Microsoft\Windows Terminal\settings.json'
    ) | ForEach-Object { Join-Path $env:LOCALAPPDATA $_ }
    foreach ($settings in $candidates) {
        if (-not (Test-Path -LiteralPath $settings)) { continue }
        try {
            $raw = [IO.File]::ReadAllText($settings, [Text.Encoding]::UTF8)
        } catch { continue }
        # JSONC: drop whole-line comments, then parse. Windows PowerShell 5.1
        # rejects trailing commas, so fall back to a regex on the raw text.
        try {
            $json = (($raw -split "`n") | Where-Object { $_ -notmatch '^\s*//' }) -join "`n" | ConvertFrom-Json
            $profilesList = if ($json.profiles.list) { @($json.profiles.list) } else { @($json.profiles) }
            $match = $profilesList | Where-Object { $_.guid -eq $guid } | Select-Object -First 1
            if ($match -and $match.name) { return [string]$match.name }
        } catch {
            $g = [regex]::Escape($guid)
            if ($raw -match ('"guid"\s*:\s*"' + $g + '"[^}]*"name"\s*:\s*"([^"]+)"')) { return $Matches[1] }
            if ($raw -match ('"name"\s*:\s*"([^"]+)"[^}]*"guid"\s*:\s*"' + $g + '"')) { return $Matches[1] }
        }
    }
    return 'PowerShell'
}

# /clear path: stamp the WT profile name, raise the reset flag so a racing
# Stop/LLM child cannot paint the previous conversation back, and drop cache
# so the next Stop is a no-op even if the flag is later cleared.
function Reset-TabTitleToProfile {
    param([uint32[]]$ConsolePids)
    Set-TabTitleResetFlag
    [void](Step-TabTitleGen)
    Clear-TabTitleState
    $title = Get-WtProfileName
    [void](Write-TabTitle -Text $title -State running -Force -NoCache -ConsolePids $ConsolePids)
    Clear-TabTitleState
}

# Attach to this tab's console and set its title.
# DESTRUCTIVE: calls FreeConsole, so this process loses its own stdio. Do all
# stdin reading, output, and child-process spawning BEFORE calling this.
# Returns the PID actually attached to, or 0 on failure.
function Write-TabTitle {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [uint32[]]$ConsolePids,
        # done = show the tab ring (turn finished); running = clear it.
        [ValidateSet('done', 'running')][string]$State = 'running',
        # Skip persisting $Text as the cached title.
        [switch]$NoCache,
        # Bypass the /clear reset flag. Only the reset script should pass this;
        # Stop and the LLM child must not paint the previous conversation back.
        [switch]$Force
    )
    if (-not $Force -and (Test-TabTitleResetFlag)) { return [uint32]0 }
    if (-not $Text) { return [uint32]0 }
    if (-not $ConsolePids -or $ConsolePids.Count -eq 0) {
        $ConsolePids = Get-TabConsolePids
    }

    if (-not $NoCache) { Set-TabTitleState $Text }

    # Title via SetConsoleTitle (per-console). OSC 0 used to go out on CONOUT$
    # and could land on a sibling tab in the same WT window. OSC 9;4 is only
    # the done-ring and stays on CONOUT$ after the ownership check.
    $progress = if ($State -eq 'done') { $script:CCTabProgressDone } else { $script:CCTabProgressClear }
    $bytes = [Text.Encoding]::UTF8.GetBytes($progress)

    foreach ($target in $ConsolePids) {
        try {
            [void][CCTab.Native]::FreeConsole()
            if (-not [CCTab.Native]::AttachConsole($target)) { continue }
            if (-not (Test-AttachedConsoleOwnedBy $ConsolePids)) {
                [void][CCTab.Native]::FreeConsole()
                continue
            }

            [void][CCTab.Native]::SetConsoleTitle($Text)
            $h = [CCTab.Native]::CreateFileW('CONOUT$', 0x40000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
            if ($h -eq [IntPtr]::new(-1)) { return [uint32]$target }

            $written = 0
            [void][CCTab.Native]::WriteFile($h, $bytes, [uint32]$bytes.Length, [ref]$written, [IntPtr]::Zero)
            [void][CCTab.Native]::CloseHandle($h)
            return [uint32]$target
        } catch { }
    }
    return [uint32]0
}
