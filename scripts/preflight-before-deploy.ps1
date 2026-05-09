$ErrorActionPreference = "Stop"

Write-Host "== TheOreum preflight =="

$branch = git rev-parse --abbrev-ref HEAD
Write-Host "Branch: $branch"

if ($branch -ne "migration-phase1-hotpath") {
  throw "Invalid branch. Expected migration-phase1-hotpath, current: $branch"
}

$statusLines = @(git status --porcelain)

$blockingStatus = $statusLines | Where-Object {
  $_ -and ($_ -notmatch '^\?\? _release([/\\].*)?$')
}

if ($blockingStatus) {
  Write-Host ""
  Write-Host "Working tree is not clean:"
  $blockingStatus | ForEach-Object {
    Write-Host $_
  }
  Write-Host ""
  throw "Uncommitted or untracked files exist. Commit, remove, or ignore them before deploy."
}

$ignoredStatus = $statusLines | Where-Object {
  $_ -and ($_ -match '^\?\? _release([/\\].*)?$')
}

if ($ignoredStatus) {
  Write-Host ""
  Write-Host "Ignoring local release artifacts:"
  $ignoredStatus | ForEach-Object {
    Write-Host $_
  }
}

Write-Host "Running syntax checks..."
npm run check

Write-Host "Running build..."
npm run build

Write-Host ""
Write-Host "Preflight OK."