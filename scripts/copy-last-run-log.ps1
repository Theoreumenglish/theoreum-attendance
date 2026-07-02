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
$DeepQaPath = Join-Path $LogDir "PRODUCTION_DEEP_QA_TO_SEND.txt"
$DeepQaBundlePath = Join-Path $LogDir "PRODUCTION_DEEP_QA_BUNDLE.zip"
$DeepQaPackagePath = Join-Path $LogDir "PRODUCTION_DEEP_QA_PACKAGE.zip"
$DeepQaSourcePath = Join-Path $LogDir "PRODUCTION_DEEP_QA_SOURCE.zip"
$DeepQaTimestampedBundle = Get-ChildItem -Path $LogDir -Filter "PRODUCTION_DEEP_QA_BUNDLE_*.zip" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$DeepQaTimestampedPackage = Get-ChildItem -Path $LogDir -Filter "PRODUCTION_DEEP_QA_PACKAGE_*.zip" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$DeepQaTimestampedSource = Get-ChildItem -Path $LogDir -Filter "PRODUCTION_DEEP_QA_SOURCE_*.zip" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
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
  if (Test-Path $DeepQaPath) {
    $Target = $DeepQaPath
  } elseif (Test-Path $SqlGatePath) {
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
  if ($Target -eq $DeepQaPath) {
    if ($DeepQaTimestampedPackage) {
      Write-Host "Deep QA full package to attach first when code + screenshots are needed:" -ForegroundColor Green
      Write-Host $DeepQaTimestampedPackage.FullName -ForegroundColor Yellow
    } elseif (Test-Path $DeepQaPackagePath) {
      Write-Host "Deep QA full package to attach first when code + screenshots are needed:" -ForegroundColor Green
      Write-Host $DeepQaPackagePath -ForegroundColor Yellow
    }

    if ($DeepQaTimestampedBundle) {
      Write-Host "Deep QA timestamped screenshot bundle:" -ForegroundColor Green
      Write-Host $DeepQaTimestampedBundle.FullName -ForegroundColor Yellow
    } elseif (Test-Path $DeepQaBundlePath) {
      Write-Host "Deep QA screenshot bundle:" -ForegroundColor Green
      Write-Host $DeepQaBundlePath -ForegroundColor Yellow
    }

    if ($DeepQaTimestampedSource) {
      Write-Host "Deep QA timestamped source snapshot:" -ForegroundColor Green
      Write-Host $DeepQaTimestampedSource.FullName -ForegroundColor Yellow
    } elseif (Test-Path $DeepQaSourcePath) {
      Write-Host "Deep QA source snapshot:" -ForegroundColor Green
      Write-Host $DeepQaSourcePath -ForegroundColor Yellow
    }
  }
} catch {
  Write-Host "Could not copy to clipboard. Open this file manually:" -ForegroundColor Yellow
  Write-Host $Target -ForegroundColor Yellow
}
