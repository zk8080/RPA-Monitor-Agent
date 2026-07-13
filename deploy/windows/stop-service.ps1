#Requires -Version 5.1
<#
.SYNOPSIS
  Stop RPA Monitor Agent Runtime (Task Scheduler + process)
#>

$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$PidFile = Join-Path $Root 'data\service.pid'
$TaskName = 'RPA-Monitor-Agent'

# Stop task first so RestartCount does not bring node back
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Write-Host "Stopping scheduled task: $TaskName"
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Seconds 1
}

if (Test-Path $PidFile) {
  $raw = (Get-Content $PidFile -Raw).Trim()
  if ($raw -match '^\d+$') {
    $targetPid = [int]$raw
    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($p) {
      Write-Host "Stopping pid=$targetPid ..."
      Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    } else {
      Write-Host "Process $targetPid already gone."
    }
  } else {
    Write-Host "Bad pid file content: $raw"
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Host 'No data\service.pid'
}

# Kill any leftover service.js under this repo
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match 'service\.js' -and
    $_.CommandLine -match 'RPA-Monitor-Agent'
  } |
  ForEach-Object {
    Write-Host "Killing leftover pid=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Write-Host 'Stopped.'
Write-Host "Note: logon auto-start task '$TaskName' is still registered. To remove it:"
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
