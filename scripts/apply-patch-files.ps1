param(
  [string]$PatchZip = "",
  [string]$CommitMessage = "chore: apply patch",
  [string]$Branch = "migration-phase1-hotpath",
  [switch]$ApplyOnly,
  [switch]$SkipDeploy,
  [switch]$NoClipboard
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
cd $ProjectDir

$RunId = Get-Date -Format "yyyyMMdd_HHmmss"
$LogDir = Join-Path $ProjectDir "_logs"
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$ApplySummaryPath = Join-Path $LogDir "LAST_PATCH_APPLY.txt"

function Copy-TextSafe {
  param([string]$Text)
  if ($NoClipboard) { return }
  try { Set-Clipboard -Value $Text } catch { }
}

if (-not $PatchZip) {
  $Downloads = Join-Path $env:USERPROFILE "Downloads"
  $LatestPatch = Get-ChildItem -Path $Downloads -Filter "*-patch.zip" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($LatestPatch) {
    $PatchZip = $LatestPatch.FullName
    Write-Host "Using latest patch zip from Downloads:" -ForegroundColor Yellow
    Write-Host $PatchZip -ForegroundColor Yellow
  } else {
    throw "PatchZip was not provided and no *-patch.zip file was found in Downloads."
  }
}

if (!(Test-Path $PatchZip)) {
  throw "Patch zip not found: $PatchZip"
}

$PatchName = [System.IO.Path]::GetFileNameWithoutExtension($PatchZip)
$PatchTemp = Join-Path $env:TEMP ($PatchName + "_" + $RunId)

if (Test-Path $PatchTemp) { Remove-Item $PatchTemp -Recurse -Force }
New-Item -ItemType Directory -Path $PatchTemp -Force | Out-Null

Write-Host ""
Write-Host "[1] Expand patch zip" -ForegroundColor Cyan
Expand-Archive -Path $PatchZip -DestinationPath $PatchTemp -Force

Write-Host ""
Write-Host "[2] Find patch-files" -ForegroundColor Cyan
$PatchFilesDir = Get-ChildItem -Path $PatchTemp -Recurse -Directory |
  Where-Object { $_.Name -eq "patch-files" } |
  Select-Object -First 1

if ($null -eq $PatchFilesDir) {
  throw "patch-files folder was not found in patch zip."
}

Write-Host $PatchFilesDir.FullName -ForegroundColor Green

Write-Host ""
Write-Host "[3] Backup existing target files" -ForegroundColor Cyan
$BackupDir = Join-Path $ProjectDir ("_patch_backup_" + $PatchName + "_" + $RunId)
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

$FilesToPatch = Get-ChildItem -Path $PatchFilesDir.FullName -Recurse -File

foreach ($File in $FilesToPatch) {
  $RelativePath = $File.FullName.Substring($PatchFilesDir.FullName.Length).TrimStart("\","/")
  $TargetPath = Join-Path $ProjectDir $RelativePath

  if (Test-Path $TargetPath) {
    $BackupPath = Join-Path $BackupDir $RelativePath
    $BackupParent = Split-Path $BackupPath -Parent
    if (!(Test-Path $BackupParent)) { New-Item -ItemType Directory -Path $BackupParent -Force | Out-Null }
    Copy-Item -Path $TargetPath -Destination $BackupPath -Force
  }
}

Write-Host "Backup folder: $BackupDir" -ForegroundColor Yellow

Write-Host ""
Write-Host "[4] Apply patch-files" -ForegroundColor Cyan
$Applied = New-Object System.Collections.Generic.List[string]

foreach ($File in $FilesToPatch) {
  $RelativePath = $File.FullName.Substring($PatchFilesDir.FullName.Length).TrimStart("\","/")
  $TargetPath = Join-Path $ProjectDir $RelativePath
  $TargetParent = Split-Path $TargetPath -Parent

  if (!(Test-Path $TargetParent)) { New-Item -ItemType Directory -Path $TargetParent -Force | Out-Null }

  Copy-Item -Path $File.FullName -Destination $TargetPath -Force
  $Applied.Add($RelativePath)
  Write-Host ("APPLIED: " + $RelativePath)
}

$Summary = @"
TheOreum patch apply completed.

Run ID: $RunId
Patch zip: $PatchZip
Backup folder: $BackupDir
Applied file count: $($Applied.Count)

Applied files:
$($Applied -join [Environment]::NewLine)

Next:
- If ApplyOnly was not set, one-click-release will run next.
- If anything fails later, send _logs/LAST_FAILURE_TO_SEND.txt.
"@

Set-Content -Path $ApplySummaryPath -Value $Summary -Encoding UTF8
Copy-TextSafe $Summary

Write-Host ""
Write-Host "Patch apply summary:" -ForegroundColor Green
Write-Host $ApplySummaryPath -ForegroundColor Yellow

if ($ApplyOnly) {
  Write-Host "ApplyOnly mode: release/deploy skipped." -ForegroundColor Yellow
  exit 0
}

Write-Host ""
Write-Host "[5] Run one-click release" -ForegroundColor Cyan
$OneClickArgs = @(
  "-ExecutionPolicy", "Bypass",
  "-File", ".\scripts\one-click-release.ps1",
  "-CommitMessage", $CommitMessage,
  "-Branch", $Branch
)

if ($SkipDeploy) { $OneClickArgs += "-SkipDeploy" }
if ($NoClipboard) { $OneClickArgs += "-NoClipboard" }

powershell @OneClickArgs
if ($global:LASTEXITCODE -ne 0) {
  throw "one-click-release failed with exit code $global:LASTEXITCODE"
}
