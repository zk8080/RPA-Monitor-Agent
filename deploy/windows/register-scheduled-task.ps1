#Requires -Version 5.1
<#
.SYNOPSIS
  Register / refresh the Task Scheduler entry (logon auto-start).
  Prefer: powershell -File deploy\windows\start-service.ps1
  which registers the same task and starts it immediately.
#>

$ErrorActionPreference = 'Stop'
$StartPs1 = Join-Path $PSScriptRoot 'start-service.ps1'
& $StartPs1
