$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

powershell -ExecutionPolicy Bypass -File scripts/preflight-before-deploy.ps1

Write-Host ""
Write-Host "Deploying to Vercel production..."
vercel --prod

Write-Host ""
Write-Host "Deployment command finished."

git status