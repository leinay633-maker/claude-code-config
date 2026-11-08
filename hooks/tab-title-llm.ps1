# Background half of the tab-title hook: compress the prompt into a short
# Chinese verb-object phrase and overwrite the fallback title.
param(
    [Parameter(Mandatory = $true)][string]$PromptFile,
    # Comma-separated PIDs of the tab console, passed down by tab-title.ps1 which
    # resolved them while the process tree was still intact.
    [string]$ConsolePids = '',
    # Generation token from the parent. If /clear or a newer prompt happened
    # while we were in flight, this no longer matches and we must not write.
    [int]$Gen = 0,
    # WT_SESSION (or pid-* fallback) from the parent. git-bash has been seen
    # dropping WT_* so the child would key state files differently and either
    # skip the gen check or paint another tab's cache.
    [string]$SessionKey = ''
)

$ErrorActionPreference = 'Stop'

if ($SessionKey) { $env:WT_SESSION = $SessionKey }

. (Join-Path $PSScriptRoot 'tab-title-lib.ps1')

$SYSTEM = '你在给开发任务起一个简短的中文标题。用动词+核心对象的动宾短语,只抓最主要的一件事,次要细节忽略,不超过10个汉字,专有名词如JWT/MySQL保留。只输出标题,不要标点、引号、解释。'

try {
    if (-not (Test-Path -LiteralPath $PromptFile)) { exit 0 }
    $prompt = [IO.File]::ReadAllText($PromptFile, [Text.Encoding]::UTF8)

    $base = if ($env:ANTHROPIC_BASE_URL) { $env:ANTHROPIC_BASE_URL } else { 'https://api.anthropic.com' }
    # The official API expects an auth token as Bearer and an API key as x-api-key.
    $headers = @{ 'anthropic-version' = '2023-06-01'; 'content-type' = 'application/json' }
    if ($env:ANTHROPIC_AUTH_TOKEN) { $headers['Authorization'] = "Bearer $env:ANTHROPIC_AUTH_TOKEN" }
    elseif ($env:ANTHROPIC_API_KEY) { $headers['x-api-key'] = $env:ANTHROPIC_API_KEY }
    # Without a credential the interim title from tab-title.ps1 simply stays.
    if ($headers.Count -lt 3 -or -not $prompt.Trim()) { exit 0 }
    $base = $base.TrimEnd('/')
    $model = if ($env:TITLE_MODEL) { $env:TITLE_MODEL } else { 'claude-sonnet-5-5' }

    # Cap input: a giant pasted prompt costs latency for no gain in title quality.
    if ($prompt.Length -gt 4000) { $prompt = $prompt.Substring(0, 4000) }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $body = @{
        model      = $model
        max_tokens = 64
        system     = $SYSTEM
        messages   = @(@{ role = 'user'; content = $prompt })
    } | ConvertTo-Json -Depth 6 -Compress

    $resp = Invoke-WebRequest -Uri "$base/v1/messages" -Method Post -UseBasicParsing `
        -Headers $headers `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20

    $json = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray()) | ConvertFrom-Json
    $title = ($json.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join ''

    # Models sometimes ignore the instruction and answer conversationally, so
    # trim hard rather than trusting the output shape.
    $title = ($title -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if (-not $title) { exit 0 }
    $title = $title -replace '[\x00-\x1f\x7f]', ''
    $title = $title -replace '["''`「」『』“”‘’]', ''
    $title = $title -replace '[。，、！？；：,.!?;:]', ''
    $title = $title.Trim()
    if (-not $title) { exit 0 }
    if ($title.Length -gt 10) { $title = $title.Substring(0, 10) }

    if ($Gen -and (Get-TabTitleGen) -ne $Gen) { exit 0 }

    $pids = @()
    if ($ConsolePids) {
        $pids = @($ConsolePids -split ',' | Where-Object { $_ } | ForEach-Object { [uint32]$_ })
    }
    # Usually the turn is still running and Stop adds the ring later. If Stop
    # already ran for this generation, keep its ring; check again after the
    # write in case Stop landed in between.
    $state = if (Test-TabTitleDone $Gen) { 'done' } else { 'running' }
    [void](Write-TabTitle -Text $title -State $state -ConsolePids $pids)
    if ($state -eq 'running' -and (Test-TabTitleDone $Gen)) {
        [void](Write-TabTitle -Text $title -State done -NoCache -ConsolePids $pids)
    }
} catch {
    # Leave the fallback title in place.
} finally {
    try { Remove-Item -LiteralPath $PromptFile -Force -ErrorAction SilentlyContinue } catch { }
}

exit 0
