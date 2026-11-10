[CmdletBinding()]
param(
  [switch]$SwitchIfClean
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$expectedBranch = 'codex/qualification-r26-carryover'
$expectedRemote = 'https://github.com/affordablefencinggc/perfect-planner.git'

$rootOutput = & git -C $repo rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw 'This folder is not a Git checkout.' }
$root = [System.IO.Path]::GetFullPath(($rootOutput | Select-Object -Last 1).Trim()).TrimEnd('\')
if (-not [string]::Equals($root, $repo.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unexpected repository root: $root"
}

$remote = (& git -C $repo remote get-url origin | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $remote -ne $expectedRemote) {
  throw "Unexpected origin remote: $remote"
}

$branch = (& git -C $repo branch --show-current | Select-Object -Last 1).Trim()
if ($branch -ne $expectedBranch) {
  if (-not $SwitchIfClean) {
    throw "Expected branch $expectedBranch; current branch is $branch. Rerun with -SwitchIfClean only after committing or saving all work."
  }
  $dirty = & git -C $repo status --porcelain
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the working tree.' }
  if ($dirty) { throw 'Refusing to switch branches while the working tree has changes.' }

  $local = & git -C $repo branch --list $expectedBranch
  if (-not $local) {
    & git -C $repo fetch origin $expectedBranch
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the requested feature branch.' }
    & git -C $repo switch --track -c $expectedBranch "origin/$expectedBranch"
  } else {
    & git -C $repo switch $expectedBranch
  }
  if ($LASTEXITCODE -ne 0) { throw 'Could not switch to the feature branch.' }
}

$head = (& git -C $repo rev-parse --short HEAD | Select-Object -Last 1).Trim()
Write-Output "Repository: $repo"
Write-Output "Branch: $expectedBranch"
Write-Output "HEAD: $head"
Write-Output "Origin: $remote"
& git -C $repo status --short --branch
if ($LASTEXITCODE -ne 0) { throw 'Could not read Git status.' }