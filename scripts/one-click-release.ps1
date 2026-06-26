param(
  [string]$CommitMessage = "chore: update theoreum portal",
  [string]$Branch = "migration-phase1-hotpath",
  [switch]$SkipDeploy
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
cd $ProjectDir

Write-Host ""
Write-Host "[1] Load smoke env" -ForegroundColor Cyan

$SmokeEnvPath = Join-Path $ProjectDir ".env.smoke.local"
if (Test-Path $SmokeEnvPath) {
  Get-Content $SmokeEnvPath | ForEach-Object {
    $Line = $_.Trim()
    if ($Line -and -not $Line.StartsWith("#") -and $Line.Contains("=")) {
      $Parts = $Line.Split("=", 2)
      [Environment]::SetEnvironmentVariable($Parts[0], $Parts[1], "Process")
    }
  }
  Write-Host "Loaded .env.smoke.local" -ForegroundColor Green
} else {
  Write-Host ".env.smoke.local not found. Smoke test may require env vars." -ForegroundColor Yellow
}

if (-not $env:SMOKE_BASE_URL) {
  $env:SMOKE_BASE_URL = "https://theoreum-attendance.vercel.app"
}

Write-Host ""
Write-Host "[2] Git status before checks" -ForegroundColor Cyan
git status

Write-Host ""
Write-Host "[3] Syntax check" -ForegroundColor Cyan
npm run check

Write-Host ""
Write-Host "[4] Full verify" -ForegroundColor Cyan
npm run verify

Write-Host ""
Write-Host "[5] Build" -ForegroundColor Cyan
npm run build

Write-Host ""
Write-Host "[6] Git add and commit if needed" -ForegroundColor Cyan
git add -A

$HasStagedChanges = git diff --cached --name-only
if ($HasStagedChanges) {
  git commit -m $CommitMessage
} else {
  Write-Host "No staged changes. Commit skipped." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[7] Push" -ForegroundColor Cyan
git push origin $Branch

Write-Host ""
Write-Host "[8] Release zip" -ForegroundColor Cyan
if (Test-Path ".\scripts\make-release-zip.ps1") {
  powershell -ExecutionPolicy Bypass -File ".\scripts\make-release-zip.ps1"
} else {
  $ReleaseDir = Join-Path $ProjectDir "releases"
  if (!(Test-Path $ReleaseDir)) {
    New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
  }
  $Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $ZipPath = Join-Path $ReleaseDir "theoreum-attendance_$Timestamp.zip"
  git archive --format zip --output $ZipPath HEAD
  Write-Host "Release zip created: $ZipPath" -ForegroundColor Green
}

if (-not $SkipDeploy) {
  Write-Host ""
  Write-Host "[9] Preflight before deploy" -ForegroundColor Cyan
  if (Test-Path ".\scripts\preflight-before-deploy.ps1") {
    powershell -ExecutionPolicy Bypass -File ".\scripts\preflight-before-deploy.ps1"
  } else {
    Write-Host "preflight-before-deploy.ps1 not found. Skipping preflight script." -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "[10] Deploy production" -ForegroundColor Cyan
  if (Test-Path ".\scripts\deploy-prod.ps1") {
    powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-prod.ps1"
  } else {
    throw "deploy-prod.ps1 not found."
  }

  Write-Host ""
  Write-Host "[11] Live smoke test" -ForegroundColor Cyan
  if (-not $env:SMOKE_STAFF_ID) {
    throw "SMOKE_STAFF_ID is missing."
  }
  if (-not $env:SMOKE_PASSWORD) {
    throw "SMOKE_PASSWORD is missing."
  }

  npm run smoke-test
} else {
  Write-Host "Deploy skipped by -SkipDeploy." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[12] Final git status" -ForegroundColor Cyan
git status

Write-Host ""
Write-Host "Done: check, verify, build, commit, push, zip, deploy, smoke-test." -ForegroundColor Green
