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
$BundlePath = Join-Path $LogDir "PRODUCTION_DEEP_QA_BUNDLE.zip"
if (Test-Path $BundlePath) { Remove-Item $BundlePath -Force }

if (Test-Path $LastDirPath) {
  $LastDir = (Get-Content $LastDirPath -Raw).Trim()
  if ($LastDir -and (Test-Path $LastDir)) {
    try {
      Compress-Archive -Path (Join-Path $LastDir "*") -DestinationPath $BundlePath -Force
      Write-Host "Deep QA screenshot bundle:" -ForegroundColor Green
      Write-Host $BundlePath -ForegroundColor Yellow
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
