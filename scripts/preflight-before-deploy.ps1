$ErrorActionPreference = "Stop"

Write-Host "== TheOreum preflight =="

$branch = git rev-parse --abbrev-ref HEAD
Write-Host "Branch: $branch"

if ($branch -ne "migration-phase1-hotpath") {
  throw "Invalid branch. Expected migration-phase1-hotpath, current: $branch"
}

$status = git status --porcelain
if ($status) {
  Write-Host ""
  Write-Host "Working tree is not clean:"
  Write-Host $status
  Write-Host ""
  throw "Uncommitted or untracked files exist. Commit, remove, or ignore them before deploy."
}

Write-Host "Running syntax checks..."
Get-ChildItem -Path api,lib,public -Recurse -Filter *.js | ForEach-Object {
  node --check $_.FullName
}

Write-Host "Running build..."
npm run build

Write-Host ""
Write-Host "Preflight OK."