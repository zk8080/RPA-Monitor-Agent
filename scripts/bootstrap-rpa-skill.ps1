#Requires -Version 5.1
# Bootstrap rpa-skill on this machine (option A: local install).
# Default: sibling folder RPA-Skill next to this repo.
#
# Examples:
#   powershell -File scripts\bootstrap-rpa-skill.ps1 -Repo git@github.com:ORG/RPA-Skill.git -WriteConfig
#   powershell -File scripts\bootstrap-rpa-skill.ps1 -WriteConfig
#
param(
  [string]$Path = "",
  [string]$Repo = "",
  [string]$Branch = "main",
  [switch]$WriteConfig
)

$ErrorActionPreference = "Continue"

function Write-Info([string]$msg) { Write-Host "[bootstrap] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "[bootstrap] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "[bootstrap] $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg) { Write-Host "[bootstrap] ERROR: $msg" -ForegroundColor Red }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $Path) {
  $Path = Join-Path (Split-Path $repoRoot -Parent) "RPA-Skill"
}
$Path = [System.IO.Path]::GetFullPath($Path)

if (-not $Repo) {
  $Repo = $env:RPA_SKILL_REPO
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Err "git not found. Install Git for Windows and add to PATH."
  exit 1
}

function Test-SkillTree([string]$root) {
  $u = Join-Path $root "scripts\understand.js"
  $r = Join-Path $root "scripts\project_reader.js"
  return (Test-Path -LiteralPath $u) -and (Test-Path -LiteralPath $r)
}

if (Test-Path -LiteralPath $Path) {
  Write-Info "directory exists: $Path"
  if (Test-Path -LiteralPath (Join-Path $Path ".git")) {
    Write-Info "git pull --ff-only"
    Push-Location $Path
    & git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "git pull failed (local changes or no remote). continue."
    }
    Pop-Location
  } else {
    Write-Warn "not a git repo; will only validate files."
  }
} else {
  if (-not $Repo) {
    Write-Err "target missing: $Path"
    Write-Host "First install needs -Repo, for example:"
    Write-Host "  powershell -File scripts\bootstrap-rpa-skill.ps1 -Repo git@github.com:ORG/RPA-Skill.git -WriteConfig"
    Write-Host "Or set env RPA_SKILL_REPO."
    exit 1
  }
  $parent = Split-Path $Path -Parent
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  Write-Info "clone $Repo -> $Path"
  & git clone --branch $Branch --single-branch $Repo $Path
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "branch $Branch failed; clone default branch"
    if (Test-Path -LiteralPath $Path) {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
    & git clone $Repo $Path
    if ($LASTEXITCODE -ne 0) {
      Write-Err "git clone failed. Check Repo URL and credentials."
      exit 1
    }
  }
}

if (-not (Test-SkillTree $Path)) {
  Write-Err "missing scripts/understand.js or scripts/project_reader.js under: $Path"
  exit 1
}

Write-Ok "rpa-skill ready: $Path"

$pathForJs = ($Path -replace '\\', '/')
$configLocal = Join-Path $repoRoot "monitor\config.local.js"
$configExample = Join-Path $repoRoot "monitor\config.example.js"

if ($WriteConfig) {
  if (-not (Test-Path -LiteralPath $configLocal)) {
    if (-not (Test-Path -LiteralPath $configExample)) {
      Write-Err "missing config.example.js"
      exit 1
    }
    Copy-Item -LiteralPath $configExample -Destination $configLocal
    Write-Info "created config.local.js from example"
  }

  $raw = [System.IO.File]::ReadAllText($configLocal)
  if ($raw -match "rpaSkillPath\s*:") {
    $raw2 = [regex]::Replace(
      $raw,
      "rpaSkillPath\s*:\s*['""][^'""]*['""]",
      "rpaSkillPath: '$pathForJs'"
    )
    if ($raw2 -eq $raw) {
      Write-Warn "could not auto-replace rpaSkillPath; set manually: $pathForJs"
    } else {
      $utf8 = New-Object System.Text.UTF8Encoding $false
      [System.IO.File]::WriteAllText($configLocal, $raw2, $utf8)
      Write-Ok "updated config.local.js rpaSkillPath -> $pathForJs"
    }
  } else {
    Write-Warn "no rpaSkillPath field in config.local.js; add: rpaSkillPath: '$pathForJs'"
  }
} else {
  Write-Info "without -WriteConfig; set one of:"
  Write-Host "  rpaSkillPath: '$pathForJs'"
  Write-Host "  `$env:RPA_SKILL_PATH = '$Path'"
}

Write-Host ""
Write-Ok "done. verify:"
Write-Host "  node -e `"const c=require('./monitor/lib/config').loadConfig(); console.log(c.rpaSkillPath)`""
Write-Host "  npm start  then open workbench -> app -> flow tab"
Write-Host ""
Write-Info "Each machine needs its own local rpa-skill (git clone/pull). Remote URL as rpaSkillPath is not supported."
