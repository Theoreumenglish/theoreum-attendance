param(
  [string]$CommitMessage = "chore: update theoreum portal",
  [string]$Branch = "migration-phase1-hotpath",
  [switch]$SkipDeploy,
  [switch]$NoClipboard,
  [switch]$SqlApplied,
  [switch]$SkipSqlGate
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
cd $ProjectDir

$RunId = Get-Date -Format "yyyyMMdd_HHmmss"
$LogDir = Join-Path $ProjectDir "_logs"
if (!(Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$TranscriptPath = Join-Path $LogDir ("one-click-release_" + $RunId + ".log")
$LastRunPath = Join-Path $LogDir "LAST_RUN.log"
$FailureCopyPath = Join-Path $LogDir "LAST_FAILURE_TO_SEND.txt"
$SuccessSummaryPath = Join-Path $LogDir "LAST_SUCCESS_SUMMARY.txt"
$PendingSqlPath = Join-Path $LogDir "PENDING_SQL_MIGRATIONS.txt"
$LastSqlPath = Join-Path $LogDir "LAST_SQL_TO_APPLY.txt"
$SqlGateCopyPath = Join-Path $LogDir "LAST_SQL_GATE_TO_SEND.txt"
$SmokeCopyPath = Join-Path $LogDir "LAST_SMOKE_TO_SEND.txt"

$TranscriptStarted = $false
$StepNo = 1

function Write-Step {
  param([string]$Label)
  Write-Host ""
  Write-Host ("[" + $script:StepNo + "] " + $Label) -ForegroundColor Cyan
  $script:StepNo += 1
}

function Invoke-NativeStep {
  param(
    [string]$Label,
    [scriptblock]$Command
  )
  Write-Step $Label
  $global:LASTEXITCODE = 0
  & $Command
  $ExitCode = $global:LASTEXITCODE
  if ($null -ne $ExitCode -and $ExitCode -ne 0) {
    throw ($Label + " failed with exit code " + $ExitCode)
  }
}

function Load-SmokeEnv {
  Write-Step "Load smoke env"
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
}

function Stop-RunTranscript {
  if ($script:TranscriptStarted) {
    try {
      Stop-Transcript | Out-Null
    } catch {
      # Transcript may already be stopped.
    }
    $script:TranscriptStarted = $false
  }
}

function Copy-TextSafe {
  param([string]$Text)
  if ($NoClipboard) { return }
  try {
    Set-Clipboard -Value $Text
    Write-Host "Copied summary to clipboard." -ForegroundColor Green
  } catch {
    Write-Host "Could not copy to clipboard. Open the file shown above." -ForegroundColor Yellow
  }
}

function Check-SqlMigrationGate {
  Write-Step "DB migration gate"

  if ($SkipSqlGate) {
    Write-Host "SQL gate skipped by -SkipSqlGate." -ForegroundColor Yellow
    return
  }

  if (!(Test-Path $PendingSqlPath)) {
    Write-Host "No pending Supabase SQL migration marker." -ForegroundColor Green
    return
  }

  $PendingText = Get-Content $PendingSqlPath -Raw

  if (-not $SqlApplied) {
    $Text = @"
=== COPY FROM HERE ===
TheOreum release stopped before deploy/smoke because Supabase SQL migration is pending.

Run ID: $RunId
Pending marker:
$PendingSqlPath

SQL to apply:
$LastSqlPath

What happened:
A patch added or changed docs/supabase-*.sql. This is a database migration. To avoid the same smoke-test failure again, the release is intentionally blocked until the SQL is applied in Supabase.

What to do now:
1. Open _logs/LAST_SQL_TO_APPLY.txt.
2. Copy the SQL from that file into Supabase SQL Editor and run it.
3. After SQL succeeds, run this command from the project folder:

npm run dev:release -- -CommitMessage "$CommitMessage" -Branch "$Branch" -SqlApplied

Pending details:
$PendingText
=== COPY TO HERE ===
"@
    Set-Content -Path $SqlGateCopyPath -Value $Text -Encoding UTF8
    Copy-TextSafe $Text
    Write-Host "SQL migration required before release." -ForegroundColor Red
    Write-Host $SqlGateCopyPath -ForegroundColor Yellow
    throw "SQL migration gate blocked release. Apply Supabase SQL first, then rerun with -SqlApplied."
  }

  $AppliedArchive = Join-Path $LogDir ("APPLIED_SQL_MIGRATIONS_" + $RunId + ".txt")
  $ArchiveText = @"
Confirmed with -SqlApplied during one-click release.
Run ID: $RunId
Confirmed at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

$PendingText
"@
  Set-Content -Path $AppliedArchive -Value $ArchiveText -Encoding UTF8
  Remove-Item $PendingSqlPath -Force
  Write-Host "Pending SQL marker cleared because -SqlApplied was provided." -ForegroundColor Green
  Write-Host $AppliedArchive -ForegroundColor Yellow
}

function New-FailureSummary {
  param([string]$Message)

  Stop-RunTranscript

  if (Test-Path $TranscriptPath) {
    Copy-Item -Path $TranscriptPath -Destination $LastRunPath -Force
  }

  $Tail = ""
  if (Test-Path $TranscriptPath) {
    $Tail = (Get-Content $TranscriptPath -Tail 180) -join [Environment]::NewLine
  }

  $Extra = ""
  if (Test-Path $SqlGateCopyPath) {
    $Extra += "`nSQL gate details:`n$SqlGateCopyPath`n"
  }
  if (Test-Path $SmokeCopyPath) {
    $Extra += "`nSmoke-test details:`n$SmokeCopyPath`n"
  }
  if (Test-Path $LastSqlPath) {
    $Extra += "`nSQL to apply:`n$LastSqlPath`n"
  }

  $Summary = @"
=== COPY FROM HERE ===
TheOreum one-click release failed.

Run ID: $RunId
Failed message:
$Message

Full log:
$TranscriptPath
$Extra
What I need you to send ChatGPT:
1. This whole block.
2. If asked, also attach or paste the full log file.
3. If this mentions SQL gate or smoke-test details, send those files too.

Last 180 log lines:
$Tail
=== COPY TO HERE ===
"@

  Set-Content -Path $FailureCopyPath -Value $Summary -Encoding UTF8
  Copy-TextSafe $Summary

  Write-Host ""
  Write-Host "FAILED. A copy-ready error summary was created:" -ForegroundColor Red
  Write-Host $FailureCopyPath -ForegroundColor Yellow
  Write-Host ""
  Write-Host "The summary has been copied to the clipboard if your PowerShell supports Set-Clipboard." -ForegroundColor Yellow
}

function New-SuccessSummary {
  Stop-RunTranscript

  if (Test-Path $TranscriptPath) {
    Copy-Item -Path $TranscriptPath -Destination $LastRunPath -Force
  }

  $Summary = @"
TheOreum one-click release completed.

Run ID: $RunId
Full log:
$TranscriptPath

Final status:
verify / commit / push / zip / deploy / smoke-test completed. verify includes syntax check and build.
"@

  Set-Content -Path $SuccessSummaryPath -Value $Summary -Encoding UTF8

  Write-Host ""
  Write-Host "SUCCESS. Full run log:" -ForegroundColor Green
  Write-Host $TranscriptPath -ForegroundColor Yellow
  Write-Host "Latest log shortcut:" -ForegroundColor Green
  Write-Host $LastRunPath -ForegroundColor Yellow
}

try {
  Start-Transcript -Path $TranscriptPath -Force | Out-Null
  $TranscriptStarted = $true

  Write-Host "TheOreum one-click release"
  Write-Host ("Run ID: " + $RunId)
  Write-Host ("Project: " + $ProjectDir)
  Write-Host ("Log: " + $TranscriptPath)

  Load-SmokeEnv
  Check-SqlMigrationGate

  Invoke-NativeStep "Git status before checks" { git status }

  Invoke-NativeStep "Full verify (includes syntax check and build)" { npm run verify }

  Write-Step "Git add and commit if needed"
  git add -A
  if ($global:LASTEXITCODE -ne 0) { throw "git add failed with exit code $global:LASTEXITCODE" }

  $HasStagedChanges = git diff --cached --name-only
  if ($global:LASTEXITCODE -ne 0) { throw "git diff --cached failed with exit code $global:LASTEXITCODE" }

  if ($HasStagedChanges) {
    git commit -m $CommitMessage
    if ($global:LASTEXITCODE -ne 0) { throw "git commit failed with exit code $global:LASTEXITCODE" }
  } else {
    Write-Host "No staged changes. Commit skipped." -ForegroundColor Yellow
  }

  Invoke-NativeStep "Push" { git push origin $Branch }

  Write-Step "Release zip"
  if (Test-Path ".\scripts\make-release-zip.ps1") {
    powershell -ExecutionPolicy Bypass -File ".\scripts\make-release-zip.ps1"
    if ($global:LASTEXITCODE -ne 0) { throw "make-release-zip.ps1 failed with exit code $global:LASTEXITCODE" }
  } else {
    $ReleaseDir = Join-Path $ProjectDir "releases"
    if (!(Test-Path $ReleaseDir)) {
      New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
    }
    $Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $ZipPath = Join-Path $ReleaseDir "theoreum-attendance_$Timestamp.zip"
    git archive --format zip --output $ZipPath HEAD
    if ($global:LASTEXITCODE -ne 0) { throw "git archive failed with exit code $global:LASTEXITCODE" }
    Write-Host "Release zip created: $ZipPath" -ForegroundColor Green
  }

  if (-not $SkipDeploy) {
    Write-Step "Preflight before deploy"
    if (Test-Path ".\scripts\preflight-before-deploy.ps1") {
      powershell -ExecutionPolicy Bypass -File ".\scripts\preflight-before-deploy.ps1"
      if ($global:LASTEXITCODE -ne 0) { throw "preflight-before-deploy.ps1 failed with exit code $global:LASTEXITCODE" }
    } else {
      Write-Host "preflight-before-deploy.ps1 not found. Skipping preflight script." -ForegroundColor Yellow
    }

    Invoke-NativeStep "Deploy production" {
      if (Test-Path ".\scripts\deploy-prod.ps1") {
        powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-prod.ps1"
      } else {
        throw "deploy-prod.ps1 not found."
      }
    }

    Write-Step "Live smoke test"
    if (-not $env:SMOKE_STAFF_ID) {
      throw "SMOKE_STAFF_ID is missing."
    }
    if (-not $env:SMOKE_PASSWORD) {
      throw "SMOKE_PASSWORD is missing."
    }

    npm run smoke-test
    if ($global:LASTEXITCODE -ne 0) { throw "smoke-test failed with exit code $global:LASTEXITCODE" }
  } else {
    Write-Host "Deploy skipped by -SkipDeploy." -ForegroundColor Yellow
  }

  Invoke-NativeStep "Final git status" { git status }

  Write-Host ""
  Write-Host "Done: verify, commit, push, zip, deploy, smoke-test. verify includes syntax check and build." -ForegroundColor Green

  New-SuccessSummary
  exit 0
} catch {
  $Message = $_.Exception.Message
  New-FailureSummary $Message
  exit 1
}
