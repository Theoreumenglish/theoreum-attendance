$ErrorActionPreference = "Stop"

Write-Host "== TheOreum preflight =="

$branch = git rev-parse --abbrev-ref HEAD
Write-Host "Branch: $branch"

if ($branch -ne "migration-phase1-hotpath") {
  throw "현재 브랜치가 migration-phase1-hotpath가 아닙니다. 현재: $branch"
}

$status = git status --porcelain
if ($status) {
  Write-Host ""
  Write-Host "Working tree is not clean:"
  Write-Host $status
  Write-Host ""
  throw "커밋되지 않은 변경사항이 있습니다. git add/commit 후 다시 실행하세요."
}

Write-Host "Running syntax checks..."
Get-ChildItem -Path api,lib,public -Recurse -Filter *.js | ForEach-Object {
  node --check $_.FullName
}

Write-Host "Running build..."
npm run build

Write-Host ""
Write-Host "Preflight OK. You can deploy:"
Write-Host "vercel --prod"