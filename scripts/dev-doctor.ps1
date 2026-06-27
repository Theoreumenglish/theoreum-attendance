param(
  [switch]$Full,
  [switch]$NoClipboard
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
cd $ProjectDir

$RunId = Get-Date -Format "yyyyMMdd_HHmmss"
$LogDir = Join-Path $ProjectDir "_logs"
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$OutPath = Join-Path $LogDir "DEV_DOCTOR_TO_SEND.txt"

function Run-Capture {
  param([string]$Label, [scriptblock]$Command)
  $output = ""
  try {
    $global:LASTEXITCODE = 0
    $output = (& $Command 2>&1 | Out-String).TrimEnd()
    $exit = $global:LASTEXITCODE
    if ($null -eq $exit) { $exit = 0 }
    return "### $Label`nexit=$exit`n$output`n"
  } catch {
    return "### $Label`nERROR: $($_.Exception.Message)`n"
  }
}

$SmokeEnvPath = Join-Path $ProjectDir ".env.smoke.local"
$GitIgnoreText = ""
if (Test-Path ".\.gitignore") { $GitIgnoreText = Get-Content ".\.gitignore" -Raw }

$RequiredFiles = @(
  "package.json",
  "vercel.json",
  "api/rpc.js",
  "public/admin.html",
  "scripts/one-click-release.ps1",
  "scripts/apply-patch-files.ps1",
  "scripts/dev-doctor.ps1",
  "scripts/quick-local-check.ps1",
  "scripts/copy-last-run-log.ps1",
  "scripts/smoke-test.mjs",
  "docs/DEVELOPER_SURFACE_ROUTINE_V1.md",
  "docs/DEV_CONVENIENCE_SUITE_V1.md"
)

$FileStatus = foreach ($f in $RequiredFiles) {
  if (Test-Path $f) { "OK $f" } else { "MISSING $f" }
}

$PkgSummary = ""
if (Test-Path ".\package.json") {
  $pkg = Get-Content ".\package.json" -Raw | ConvertFrom-Json
  $nodeEngine = $pkg.engines.node
  $scriptNames = ($pkg.scripts.PSObject.Properties.Name | Sort-Object) -join ", "
  $PkgSummary = "node engine: $nodeEngine`nscripts: $scriptNames"
}

$LastFailurePath = Join-Path $LogDir "LAST_FAILURE_TO_SEND.txt"
$PendingSqlPath = Join-Path $LogDir "PENDING_SQL_MIGRATIONS.txt"
$LastSqlPath = Join-Path $LogDir "LAST_SQL_TO_APPLY.txt"
$LastSmokePath = Join-Path $LogDir "LAST_SMOKE_TO_SEND.txt"
$LastSuccessPath = Join-Path $LogDir "LAST_SUCCESS_SUMMARY.txt"
$LastRunPath = Join-Path $LogDir "LAST_RUN.log"

$LastLogInfo = @()
foreach ($p in @($PendingSqlPath, $LastSqlPath, $LastSmokePath, $LastFailurePath, $LastSuccessPath, $LastRunPath)) {
  if (Test-Path $p) {
    $item = Get-Item $p
    $LastLogInfo += "$($item.Name): $($item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
  }
}

$SurfaceChecklist = @"
Vercel: check package engines.node, build, deploy, production smoke-test.
Supabase: check whether SQL migration/RLS/index/privacy impact is needed.
GitHub: check branch, commit, push, and whether release zip is created.
OpenAI Platform: check only when AI/API/key/model integration is touched; never paste secrets.
Google Drive: check only when docs/sheets/slides/drive backup or handoff is touched.
"@

$ReportParts = @()
$ReportParts += "=== COPY FROM HERE ==="
$ReportParts += "TheOreum dev doctor report"
$ReportParts += "Run ID: $RunId"
$ReportParts += "Project: $ProjectDir"
$ReportParts += ""
$ReportParts += "## Package"
$ReportParts += $PkgSummary
$ReportParts += ""
$ReportParts += "## Local secret safety"
$ReportParts += ".env.smoke.local exists: $(Test-Path $SmokeEnvPath)"
$ReportParts += ".env.smoke.local ignored: $($GitIgnoreText -match '(?m)^\.env\.smoke\.local$')"
$ReportParts += "_logs ignored: $($GitIgnoreText -match '(?m)^_logs/$')"
$ReportParts += ""
$ReportParts += "## Required files"
$ReportParts += ($FileStatus -join [Environment]::NewLine)
$ReportParts += ""
$ReportParts += "## Developer surface checklist"
$ReportParts += $SurfaceChecklist
$ReportParts += ""
$ReportParts += "## Git"
$ReportParts += (Run-Capture "git status" { git status })
$ReportParts += (Run-Capture "git branch" { git branch --show-current })
$ReportParts += (Run-Capture "recent commits" { git log --oneline -5 })
$ReportParts += ""
$ReportParts += "## Runtime"
$ReportParts += (Run-Capture "node version" { node -v })
$ReportParts += (Run-Capture "npm version" { npm -v })
$ReportParts += ""
$ReportParts += "## DB migration gate"
$ReportParts += "pending SQL marker exists: $(Test-Path $PendingSqlPath)"
$ReportParts += "last SQL bundle exists: $(Test-Path $LastSqlPath)"
$ReportParts += ""
$ReportParts += "## Last logs"
if ($LastLogInfo.Count -gt 0) {
  $ReportParts += ($LastLogInfo -join [Environment]::NewLine)
} else {
  $ReportParts += "No _logs summary files yet."
}

if ($Full) {
  $ReportParts += ""
  $ReportParts += "## Full quick checks"
  $ReportParts += (Run-Capture "npm run check" { npm run check })
  $ReportParts += (Run-Capture "npm run ops-checklist" { npm run ops-checklist })
}

$ReportParts += "=== COPY TO HERE ==="

$Report = $ReportParts -join [Environment]::NewLine
Set-Content -Path $OutPath -Value $Report -Encoding UTF8

if (-not $NoClipboard) {
  try {
    Set-Clipboard -Value $Report
    Write-Host "Dev doctor report copied to clipboard." -ForegroundColor Green
  } catch {
    Write-Host "Clipboard copy failed. Open the file below." -ForegroundColor Yellow
  }
}

Write-Host "Dev doctor report:" -ForegroundColor Green
Write-Host $OutPath -ForegroundColor Yellow
