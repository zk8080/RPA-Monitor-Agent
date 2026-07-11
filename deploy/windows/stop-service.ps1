#Requires -Version 5.1
<#
.SYNOPSIS
  停止 RPA Monitor Agent Runtime
#>

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$PidFile = Join-Path $Root 'data\service.pid'

if (-not (Test-Path $PidFile)) {
  Write-Host '未找到 data\service.pid，可能未在运行。'
  exit 0
}

$raw = (Get-Content $PidFile -Raw).Trim()
if ($raw -notmatch '^\d+$') {
  Write-Host "pid 文件内容异常，已删除: $raw"
  Remove-Item $PidFile -Force
  exit 0
}

$targetPid = [int]$raw
$p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($p) {
  Write-Host "停止 pid=$targetPid …"
  Stop-Process -Id $targetPid -Force
  Start-Sleep -Seconds 1
} else {
  Write-Host "进程 $targetPid 已不存在，清理 pid 文件。"
}

if (Test-Path $PidFile) {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
Write-Host '已停止。'
