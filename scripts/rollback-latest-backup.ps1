param(
  [string]$BackupDir = "",
  [switch]$NoVerify
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
cd $ProjectDir

if (-not $BackupDir) {
  $Latest = Get-ChildItem -Path $ProjectDir -Directory -Force |
    Where-Object { $_.Name -like "_patch_backup_*" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $Latest) {
    throw "No _patch_backup_* folder found."
  }

  $BackupDir = $Latest.FullName
}

if (!(Test-Path $BackupDir)) {
  throw "BackupDir not found: $BackupDir"
}

Write-Host "Rolling back from backup:" -ForegroundColor Yellow
Write-Host $BackupDir -ForegroundColor Yellow

Copy-Item -Path (Join-Path $BackupDir "*") -Destination $ProjectDir -Recurse -Force

Write-Host "Rollback copy completed." -ForegroundColor Green

if (-not $NoVerify) {
  npm run verify
  if ($global:LASTEXITCODE -ne 0) {
    throw "npm run verify failed after rollback."
  }
}

git status
