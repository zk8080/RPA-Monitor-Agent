#Requires -Version 5.1
<#
.SYNOPSIS
  Start RPA Monitor Agent as a background service (with logs).

.DESCRIPTION
  Run from repo root:
    powershell -File deploy\windows\start-service.ps1

  Starts via Windows Task Scheduler so the process is NOT a child of the
  current terminal. Closing the PowerShell / Cursor terminal will NOT kill it.

  Triggers:
    - At logon (user session)
    - Daily 08:55 (if process died overnight, restart before reportCron 09:05;
      if still alive, MultipleInstances=IgnoreNew skips duplicate)

  Logs: data\logs\service-yyyyMMdd.log (written by service.js)
  Single instance: data\service.pid
#>

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

$TaskName = 'RPA-Monitor-Agent'
$PidFile = Join-Path $Root 'data\service.pid'
$LogDir = Join-Path $Root 'data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir ("service-{0:yyyyMMdd}.log" -f (Get-Date))

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  Write-Error 'node not found. Install Node.js >= 18 and add it to PATH.'
}
$NodePath = $Node.Source

$port = if ($env:HEALTH_PORT) { $env:HEALTH_PORT } else { '8787' }

Write-Host "Root: $Root"
Write-Host "Log:  $Log"
Write-Host "HEALTH_PORT=$port"
Write-Host "Registering Task Scheduler ($TaskName)..."

# Task action = node directly (not powershell). Task Scheduler owns the process tree.
$action = New-ScheduledTaskAction `
  -Execute $NodePath `
  -Argument 'monitor/service.js' `
  -WorkingDirectory $Root

# Unlimited run time; restart if node crashes; IgnoreNew if still alive
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

# 1) 登录自启  2) 每天 08:55 兜底拉起（晨报 reportCron=09:05 前）
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$triggerMorning = New-ScheduledTaskTrigger -Daily -At '08:55'
$triggers = @($triggerLogon, $triggerMorning)

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -Principal $principal `
    -Description 'RPA Monitor & Diagnosis Agent Runtime (logon + daily 08:55; detached from terminal)' `
    -Force | Out-Null
  Write-Host "Task registered: logon + daily 08:55 (IgnoreNew if already running)"
} catch {
  Write-Error "Register-ScheduledTask failed: $($_.Exception.Message). Try running PowerShell as the logged-in user (not a restricted context)."
}

# Already running? Keep process; task definition is already refreshed above.
if (Test-Path $PidFile) {
  $old = (Get-Content $PidFile -Raw).Trim()
  if ($old -match '^\d+$') {
    $p = Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue
    if ($p) {
      Write-Host "Already running pid=$old ($($p.ProcessName)). Task triggers updated; not restarting."
      Write-Host "Workbench: http://127.0.0.1:$port/"
      Write-Host "Stop: powershell -File deploy\windows\stop-service.ps1"
      exit 0
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Write-Host "Starting via Task Scheduler..."

# Ensure not left in Running state from a dead process
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 500

Start-ScheduledTask -TaskName $TaskName

# Wait for health
$ok = $false
$newPid = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $PidFile) {
    $raw = (Get-Content $PidFile -Raw).Trim()
    if ($raw -match '^\d+$') {
      $newPid = [int]$raw
      $alive = Get-Process -Id $newPid -ErrorAction SilentlyContinue
      if (-not $alive) { continue }
    }
  }
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health" -f $port) -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}

$line = "[{0}] started via TaskScheduler task={1} pid={2} HEALTH_PORT={3} triggers=logon+daily-08:55" -f (Get-Date).ToString('o'), $TaskName, $newPid, $port
Add-Content -Path $Log -Value $line -Encoding utf8

if ($ok) {
  Write-Host "OK pid=$newPid"
  Write-Host "Workbench: http://127.0.0.1:$port/"
  Write-Host "Health:    http://127.0.0.1:$port/health"
  Write-Host ""
  Write-Host "You CAN close this terminal. Service runs under Task Scheduler."
  Write-Host "Stop: powershell -File deploy\windows\stop-service.ps1"
} else {
  Write-Host "Task started but /health not ready yet. Check:"
  Write-Host "  $Log"
  Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
  if (Test-Path $Log) { Get-Content $Log -Tail 30 }
  exit 1
}
