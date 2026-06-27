param(
  [switch]$FullLog
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $ProjectDir "_logs"
$FailurePath = Join-Path $LogDir "LAST_FAILURE_TO_SEND.txt"
$SqlGatePath = Join-Path $LogDir "LAST_SQL_GATE_TO_SEND.txt"
$SqlApplyPath = Join-Path $LogDir "LAST_SQL_TO_APPLY.txt"
$SmokePath = Join-Path $LogDir "LAST_SMOKE_TO_SEND.txt"
$LastRunPath = Join-Path $LogDir "LAST_RUN.log"
$SuccessPath = Join-Path $LogDir "LAST_SUCCESS_SUMMARY.txt"

if (!(Test-Path $LogDir)) {
  throw "_logs folder not found. Run one-click-release first."
}

$Target = $null

if ($FullLog) {
  if (Test-Path $LastRunPath) {
    $Target = $LastRunPath
  }
} else {
  if (Test-Path $SqlGatePath) {
    $Target = $SqlGatePath
  } elseif (Test-Path $SqlApplyPath) {
    $Target = $SqlApplyPath
  } elseif (Test-Path $SmokePath) {
    $Target = $SmokePath
  } elseif (Test-Path $FailurePath) {
    $Target = $FailurePath
  } elseif (Test-Path $SuccessPath) {
    $Target = $SuccessPath
  } elseif (Test-Path $LastRunPath) {
    $Target = $LastRunPath
  }
}

if (-not $Target) {
  throw "No copy-ready log found in _logs."
}

$Text = Get-Content $Target -Raw
try {
  Set-Clipboard -Value $Text
  Write-Host "Copied to clipboard:" -ForegroundColor Green
  Write-Host $Target -ForegroundColor Yellow
} catch {
  Write-Host "Could not copy to clipboard. Open this file manually:" -ForegroundColor Yellow
  Write-Host $Target -ForegroundColor Yellow
}
