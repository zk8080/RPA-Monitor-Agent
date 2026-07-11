#Requires -Version 5.1
<#
.SYNOPSIS
  启动 RPA Monitor Agent 常驻 Runtime（后台 + 日志）

.DESCRIPTION
  在仓库根目录运行：
    powershell -File deploy\windows\start-service.ps1

  日志：data\logs\service-yyyyMMdd.log
  若已有存活实例（data\service.pid），则拒绝重复启动。
#>

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Root

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  Write-Error '未找到 node。请安装 Node.js >= 18 并加入 PATH。'
}

$PidFile = Join-Path $Root 'data\service.pid'
if (Test-Path $PidFile) {
  $old = (Get-Content $PidFile -Raw).Trim()
  if ($old -match '^\d+$') {
    $p = Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue
    if ($p) {
      Write-Host "已在运行 pid=$old ($($p.ProcessName))。先 stop-service.ps1 或结束该进程。"
      exit 1
    }
  }
}

$LogDir = Join-Path $Root 'data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir ("service-{0:yyyyMMdd}.log" -f (Get-Date))

$env:HEALTH_PORT = if ($env:HEALTH_PORT) { $env:HEALTH_PORT } else { '8787' }

Write-Host "Root: $Root"
Write-Host "Log:  $Log"
Write-Host "HEALTH_PORT=$($env:HEALTH_PORT)"
Write-Host "启动 service.js …"

$stdout = Join-Path $LogDir 'service-stdout.log'
$stderr = Join-Path $LogDir 'service-stderr.log'

$proc = Start-Process -FilePath $Node.Source `
  -ArgumentList @('monitor/service.js') `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

Start-Sleep -Seconds 2
if ($proc.HasExited) {
  Write-Host "进程已退出 code=$($proc.ExitCode)。查看:"
  Write-Host "  $stderr"
  if (Test-Path $stderr) { Get-Content $stderr -Tail 30 }
  exit 1
}

# 追加启动记录到日日志
$line = "[{0}] started pid={1} HEALTH_PORT={2}" -f (Get-Date).ToString('o'), $proc.Id, $env:HEALTH_PORT
Add-Content -Path $Log -Value $line
Write-Host "OK pid=$($proc.Id)。健康检查: curl http://127.0.0.1:$($env:HEALTH_PORT)/health"
Write-Host "停止: powershell -File deploy\windows\stop-service.ps1"
