param(
  [string]$StaffId = "",
  [string]$Password = "",
  [string]$BaseUrl = "https://theoreum-attendance.vercel.app"
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvPath = Join-Path $ProjectDir ".env.smoke.local"

if (-not $StaffId) {
  throw "StaffId is required."
}

if (-not $Password) {
  throw "Password is required."
}

$Content = @"
SMOKE_BASE_URL=$BaseUrl
SMOKE_STAFF_ID=$StaffId
SMOKE_PASSWORD=$Password
"@

Set-Content -Path $EnvPath -Value $Content -Encoding UTF8

Write-Host "Smoke env saved to .env.smoke.local" -ForegroundColor Green
Write-Host "This file must stay local and must not be committed." -ForegroundColor Yellow
