param(
  [string]$BaseUrl = "",
  [string]$StaffId = "",
  [string]$Password = "",
  [string]$StudentQuery = "",
  [string]$StudentTail8 = "",
  [string]$StaffTail8 = "",
  [switch]$Write,
  [switch]$Headless,
  [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $ProjectDir "_logs"
$DeepDir = Join-Path $LogDir "deep-qa"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
New-Item -ItemType Directory -Path $DeepDir -Force | Out-Null

Set-Location $ProjectDir

if ($BaseUrl) { $env:QA_BASE_URL = $BaseUrl }
if ($StaffId) { $env:QA_STAFF_ID = $StaffId }
if ($Password) { $env:QA_PASSWORD = $Password }
if ($StudentQuery) { $env:QA_STUDENT_QUERY = $StudentQuery }
if ($StudentTail8) { $env:QA_STUDENT_TAIL8 = $StudentTail8 }
if ($StaffTail8) { $env:QA_STAFF_TAIL8 = $StaffTail8 }
if ($Write) { $env:QA_WRITE = "1" }
if ($Headless) { $env:QA_HEADLESS = "1" }

Write-Host ""
Write-Host "TheOreum production deep click QA" -ForegroundColor Cyan
Write-Host "Project: $ProjectDir"
if ($env:QA_BASE_URL) { Write-Host "Base URL: $($env:QA_BASE_URL)" }

$HasPlaywright = $false
$Check = & node -e "import('playwright').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>$null
if ($LASTEXITCODE -eq 0) { $HasPlaywright = $true }

if (-not $HasPlaywright) {
  if ($NoInstall) {
    throw "Playwright is not installed. Run without -NoInstall or run: npm install --no-save playwright@1"
  }

  Write-Host ""
  Write-Host "Playwright not found. Installing temporary browser QA dependency..." -ForegroundColor Yellow
  Write-Host "This happens only the first time on this PC." -ForegroundColor Yellow
  & npm install --no-save playwright@1
  if ($LASTEXITCODE -ne 0) {
    throw "npm install --no-save playwright@1 failed with exit code $LASTEXITCODE"
  }
}

$ArgsList = @()
if ($Write) { $ArgsList += "--write" }
if ($Headless) { $ArgsList += "--headless" }

& node ".\scripts\production-deep-click-qa.mjs" @ArgsList
$ExitCode = $LASTEXITCODE

$LastDirPath = Join-Path $LogDir "PRODUCTION_DEEP_QA_LAST_DIR.txt"
$LatestBundlePath = Join-Path $LogDir "PRODUCTION_DEEP_QA_BUNDLE.zip"

if (Test-Path $LastDirPath) {
  $LastDir = (Get-Content $LastDirPath -Raw).Trim()
  if ($LastDir -and (Test-Path $LastDir)) {
    try {
      $RunId = Split-Path $LastDir -Leaf
      $TimestampedBundlePath = Join-Path $LogDir ("PRODUCTION_DEEP_QA_BUNDLE_" + $RunId + ".zip")
      $CopyPathForBundle = Join-Path $LogDir "PRODUCTION_DEEP_QA_TO_SEND.txt"
      $ReportPathForBundle = Join-Path $LogDir "PRODUCTION_DEEP_QA_REPORT.md"
      $RawPathForBundle = Join-Path $LogDir "PRODUCTION_DEEP_QA_RAW.json"
      if (Test-Path $CopyPathForBundle) { Copy-Item $CopyPathForBundle -Destination (Join-Path $LastDir "PRODUCTION_DEEP_QA_TO_SEND.txt") -Force }
      if (Test-Path $ReportPathForBundle) { Copy-Item $ReportPathForBundle -Destination (Join-Path $LastDir "PRODUCTION_DEEP_QA_REPORT.md") -Force }
      if (Test-Path $RawPathForBundle) { Copy-Item $RawPathForBundle -Destination (Join-Path $LastDir "PRODUCTION_DEEP_QA_RAW.json") -Force }
      $IndexPath = Join-Path $LastDir "README_SCREENSHOTS.txt"
      $IndexText = @(
        "TheOreum Production Deep QA screenshot bundle",
        "Generated: $(Get-Date -Format o)",
        "Run ID: $RunId",
        "Base URL: $($env:QA_BASE_URL)",
        "",
        "Open PRODUCTION_DEEP_QA_TO_SEND.txt first.",
        "PNG files are Playwright page screenshots. They capture the tested browser page, not your whole desktop.",
        "Other apps/windows on your monitor are not included in these screenshots.",
        "Do not type/click in the QA browser while the runner is working, because focus can affect the test.",
        "*_dom.json files are DOM audits for debugging."
      ) -join "`r`n"
      Set-Content -Path $IndexPath -Value $IndexText -Encoding UTF8
      if (Test-Path $TimestampedBundlePath) { Remove-Item $TimestampedBundlePath -Force }
      if (Test-Path $LatestBundlePath) { Remove-Item $LatestBundlePath -Force }
      Compress-Archive -Path (Join-Path $LastDir "*") -DestinationPath $TimestampedBundlePath -Force
      Copy-Item -Path $TimestampedBundlePath -Destination $LatestBundlePath -Force
      Write-Host "Deep QA timestamped screenshot bundle:" -ForegroundColor Green
      Write-Host $TimestampedBundlePath -ForegroundColor Yellow
      Write-Host "Deep QA latest bundle alias:" -ForegroundColor Green
      Write-Host $LatestBundlePath -ForegroundColor Yellow
    } catch {
      Write-Host "Could not create screenshot bundle: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

$CopyPath = Join-Path $LogDir "PRODUCTION_DEEP_QA_TO_SEND.txt"
if (Test-Path $CopyPath) {
  try {
    Set-Clipboard -Value (Get-Content $CopyPath -Raw)
    Write-Host "Copied deep QA report to clipboard:" -ForegroundColor Green
    Write-Host $CopyPath -ForegroundColor Yellow
  } catch {
    Write-Host "Open and send this file:" -ForegroundColor Yellow
    Write-Host $CopyPath -ForegroundColor Yellow
  }
}

exit $ExitCode
