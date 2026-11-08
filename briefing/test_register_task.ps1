$ErrorActionPreference = 'Stop'
$global:BriefingTaskTest = @{ Existing = @(); Registrations = @(); Triggers = @(); Actions = @() }

function Assert-Briefing([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    Write-Output "PASS: $Message"
}

function Get-ScheduledTask { param($TaskPath, $ErrorAction) $global:BriefingTaskTest.Existing }
function New-ScheduledTaskAction {
    param($Execute, $Argument, $WorkingDirectory)
    $action = [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
    $global:BriefingTaskTest.Actions += $action
    return $action
}
function New-ScheduledTaskTrigger {
    param([switch]$Daily, $At)
    $trigger = [pscustomobject]@{ Daily = $Daily.IsPresent; At = $At }
    $global:BriefingTaskTest.Triggers += $trigger
    return $trigger
}
function New-ScheduledTaskSettingsSet {
    param([switch]$StartWhenAvailable, [switch]$WakeToRun, $MultipleInstances, [switch]$AllowStartIfOnBatteries,
          [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit)
    return [pscustomobject]@{ MultipleInstances = $MultipleInstances; ExecutionTimeLimit = $ExecutionTimeLimit }
}
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) [pscustomobject]@{ LogonType = $LogonType; RunLevel = $RunLevel } }
function New-ScheduledTask {
    param($Action, $Trigger, $Settings, $Principal, $Description)
    return [pscustomobject]@{ Actions = @($Action); Triggers = @($Trigger); Settings = $Settings; Description = $Description }
}
function Register-ScheduledTask {
    param($TaskName, $TaskPath, $InputObject, $ErrorAction, [switch]$Force)
    $global:BriefingTaskTest.Registrations += [pscustomobject]@{ Name = $TaskName; Definition = $InputObject; Force = $Force.IsPresent }
}
function Get-ScheduledTaskInfo { param($TaskName, $TaskPath) [pscustomobject]@{ TaskName = $TaskName; NextRunTime = 'mock' } }

$installer = Join-Path $PSScriptRoot 'register-task.ps1'
$parameters = @{ TaskName = 'briefing-test'; OutputDir = (Join-Path $PSScriptRoot '.test-output\task output'); BoardDir = (Join-Path $PSScriptRoot '.test-output\board') }
try {
    $global:BriefingTaskTest.Existing = @([pscustomobject]@{ TaskName = 'briefing-test'; Description = 'unrelated'; Actions = @() })
    $rejected = $false
    try { & $installer @parameters | Out-Null } catch { $rejected = $_.Exception.Message -like '*已有同名任务*' }
    Assert-Briefing $rejected '其他同名任务被拒绝'
    Assert-Briefing ($global:BriefingTaskTest.Registrations.Count -eq 0) '拒绝时没有注册调用'

    $global:BriefingTaskTest.Existing = @()
    & $installer @parameters | Out-Null
    $created = $global:BriefingTaskTest.Registrations[-1]
    Assert-Briefing (-not $created.Force) '新任务不用 Force，防止覆盖并发创建的任务'
    Assert-Briefing ($created.Definition.Triggers.Count -eq 2) '默认包含主运行和补跑两个触发器'
    Assert-Briefing ($created.Definition.Triggers[0].At.ToString('HH:mm') -eq '09:30') '默认主运行时间为本地 09:30'
    Assert-Briefing ($created.Definition.Triggers[1].At.ToString('HH:mm') -eq '14:30') '默认补跑时间为本地 14:30'
    Assert-Briefing ($created.Definition.Actions[0].Arguments -like '*"--no-web"*') '网页默认关闭'
    Assert-Briefing ($created.Definition.Actions[0].Arguments -like '*"--output-dir"*"task output"*' -or
        $created.Definition.Actions[0].Arguments.Contains('task output')) '带空格的输出目录保存在任务参数中'

    $global:BriefingTaskTest.Existing = @([pscustomobject]@{
        TaskName = 'briefing-test'; Description = $created.Definition.Description; Actions = $created.Definition.Actions
    })
    & $installer @parameters -Time '10:05' -RetryTime '' -Web -NoCodex | Out-Null
    $updated = $global:BriefingTaskTest.Registrations[-1]
    Assert-Briefing $updated.Force '只更新属于同一安装目录的任务'
    Assert-Briefing ($updated.Definition.Triggers.Count -eq 1) '空补跑时间可关闭补跑'
    Assert-Briefing ($updated.Definition.Triggers[0].At.ToString('HH:mm') -eq '10:05') '自定义本地运行时间生效'
    Assert-Briefing ($updated.Definition.Actions[0].Arguments.Contains('"--web"')) '网页设置被保存'
    Assert-Briefing ($updated.Definition.Actions[0].Arguments.Contains('"--no-codex"')) '备用模型关闭设置被保存'

    $count = $global:BriefingTaskTest.Registrations.Count
    & $installer @parameters -WhatIf | Out-Null
    Assert-Briefing ($global:BriefingTaskTest.Registrations.Count -eq $count) 'WhatIf 没有注册调用'

    $global:BriefingTaskTest.Existing = @([pscustomobject]@{
        TaskName = 'briefing-test'; Description = 'claude-code-config/briefing:v1'; Actions = @([pscustomobject]@{ Arguments = 'other-launcher' })
    })
    $rejected = $false
    try { & $installer @parameters | Out-Null } catch { $rejected = $_.Exception.Message -like '*已有同名任务*' }
    Assert-Briefing $rejected '相同标记但入口属于其他安装目录时也拒绝'
    Write-Output '计划任务离线测试全部通过；全部任务命令均为内存替身'
} finally {
    Remove-Variable -Name BriefingTaskTest -Scope Global
}
