param(
  [switch]$CopySql,
  [switch]$NoClipboard
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
cd $ProjectDir

$LogDir = Join-Path $ProjectDir "_logs"
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$PendingSqlPath = Join-Path $LogDir "PENDING_SQL_MIGRATIONS.txt"
$LastSqlPath = Join-Path $LogDir "LAST_SQL_TO_APPLY.txt"

Write-Host "TheOreum DB migration status" -ForegroundColor Cyan
Write-Host "Project: $ProjectDir"
Write-Host ""

$SqlFiles = Get-ChildItem -Path ".\docs" -Filter "supabase-*.sql" -File -ErrorAction SilentlyContinue | Sort-Object Name
Write-Host "Known SQL migration files:" -ForegroundColor Cyan
if ($SqlFiles.Count -eq 0) {
  Write-Host "None"
} else {
  foreach ($f in $SqlFiles) { Write-Host ("- docs/" + $f.Name) }
}

Write-Host ""
if (Test-Path $PendingSqlPath) {
  Write-Host "PENDING SQL marker exists:" -ForegroundColor Red
  Write-Host $PendingSqlPath -ForegroundColor Yellow
  if (Test-Path $LastSqlPath) {
    Write-Host "SQL bundle:" -ForegroundColor Yellow
    Write-Host $LastSqlPath -ForegroundColor Yellow
    if ($CopySql -and -not $NoClipboard) {
      try {
        Set-Clipboard -Value (Get-Content $LastSqlPath -Raw)
        Write-Host "SQL bundle copied to clipboard." -ForegroundColor Green
      } catch {
        Write-Host "Clipboard copy failed." -ForegroundColor Yellow
      }
    }
  }
} else {
  Write-Host "No pending SQL marker." -ForegroundColor Green
}
