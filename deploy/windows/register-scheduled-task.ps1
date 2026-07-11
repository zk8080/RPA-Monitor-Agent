#Requires -Version 5.1
<#
.SYNOPSIS
  注册 Windows 任务计划：登录时启动 Agent Runtime
#>

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$StartPs1 = Join-Path $Root 'deploy\windows\start-service.ps1'
$TaskName = 'RPA-Monitor-Agent'

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$StartPs1`"" `
  -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'RPA Monitor & Diagnosis Agent Runtime' `
  -Force | Out-Null

Write-Host "已注册任务计划: $TaskName"
Write-Host "立即运行: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "删除任务: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
