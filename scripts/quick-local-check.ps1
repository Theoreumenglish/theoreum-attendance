param(
  [switch]$NoClipboard
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
cd $ProjectDir

$RunId = Get-Date -Format "yyyyMMdd_HHmmss"
$LogDir = Join-Path $ProjectDir "_logs"
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$TranscriptPath = Join-Path $LogDir ("quick-local-check_" + $RunId + ".log")
$SummaryPath = Join-Path $LogDir "LAST_QUICK_CHECK_TO_SEND.txt"

$TranscriptStarted = $false

function Stop-LocalTranscript {
  if ($script:TranscriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
    $script:TranscriptStarted = $false
  }
}

function Run-Step {
  param([string]$Label, [scriptblock]$Command)
  Write-Host ""
  Write-Host $Label -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  & $Command
  $exit = $global:LASTEXITCODE
  if ($null -ne $exit -and $exit -ne 0) {
    throw "$Label failed with exit code $exit"
  }
}

try {
  Start-Transcript -Path $TranscriptPath -Force | Out-Null
  $TranscriptStarted = $true

  Write-Host "TheOreum quick local check"
  Write-Host "Run ID: $RunId"

  Run-Step "[1] git status" { git status }
  Run-Step "[2] npm run check" { npm run check }
  Run-Step "[3] npm run verify" { npm run verify }
  Run-Step "[4] npm run build" { npm run build }

  Stop-LocalTranscript

  $Summary = @"
TheOreum quick local check passed.

Run ID: $RunId
Full log:
$TranscriptPath

Result:
git status / check / verify / build passed.
"@

  Set-Content -Path $SummaryPath -Value $Summary -Encoding UTF8
  if (-not $NoClipboard) {
    try { Set-Clipboard -Value $Summary } catch { }
  }

  Write-Host ""
  Write-Host "Quick local check passed." -ForegroundColor Green
  Write-Host $TranscriptPath -ForegroundColor Yellow
  exit 0
} catch {
  $Message = $_.Exception.Message
  Stop-LocalTranscript

  $Tail = ""
  if (Test-Path $TranscriptPath) {
    $Tail = (Get-Content $TranscriptPath -Tail 160) -join [Environment]::NewLine
  }

  $Summary = @"
=== COPY FROM HERE ===
TheOreum quick local check failed.

Run ID: $RunId
Message:
$Message

Full log:
$TranscriptPath

Last 160 log lines:
$Tail
=== COPY TO HERE ===
"@

  Set-Content -Path $SummaryPath -Value $Summary -Encoding UTF8
  if (-not $NoClipboard) {
    try { Set-Clipboard -Value $Summary } catch { }
  }

  Write-Host ""
  Write-Host "Quick local check failed. Copy-ready summary:" -ForegroundColor Red
  Write-Host $SummaryPath -ForegroundColor Yellow
  exit 1
}
