$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$outDir = Join-Path $root "_release"
$outFile = Join-Path $outDir "theoreum-attendance_$stamp.zip"

if (!(Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

$excludeDirs = @(
  ".git",
  ".vercel",
  "node_modules",
  "dist",
  "_release"
)

$excludeFiles = @(
  ".env",
  ".env.local",
  ".env.development.local",
  ".env.production.local",
  ".env.preview.local",
  ".DS_Store",
  "Thumbs.db"
)

$excludeExtensions = @(
  ".zip",
  ".log"
)

$temp = Join-Path $env:TEMP ("theoreum_release_" + $stamp)
if (Test-Path $temp) {
  Remove-Item -Recurse -Force $temp
}
New-Item -ItemType Directory -Path $temp | Out-Null

Get-ChildItem -Path $root -Force | ForEach-Object {
  $name = $_.Name

  if ($_.PSIsContainer -and ($excludeDirs -contains $name)) {
    return
  }

  if (!$_.PSIsContainer -and ($excludeFiles -contains $name)) {
    return
  }

  if (!$_.PSIsContainer -and ($name -like ".env*")) {
    return
    }

  if (!$_.PSIsContainer -and ($excludeExtensions -contains $_.Extension.ToLower())) {
    return
  }

  Copy-Item $_.FullName -Destination $temp -Recurse -Force
}

Compress-Archive -Path (Join-Path $temp "*") -DestinationPath $outFile -Force
Remove-Item -Recurse -Force $temp

Write-Host "Release zip created:"
Write-Host $outFile