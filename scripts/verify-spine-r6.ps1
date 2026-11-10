$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:COMPUTERNAME -ne 'DANS1') { throw 'Wrong computer' }
$project = 'C:\Users\danie\projects\Planner-Spine-Repair-20261104'
$evidence = 'C:\Users\danie\Documents\PerfectPlannerEvidence\20261104-Spine\r6'
$tempRoot = Join-Path $project '.tmp-durable-r6'
New-Item -ItemType Directory -Force $evidence, $tempRoot | Out-Null
Set-Location -LiteralPath $project
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$node = 'C:\Program Files\nodejs\node.exe'
$npm = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
$results = @()
function Run-Check([string] $phase, [string[]] $arguments) {
  [pscustomobject]@{ phase=$phase; state='running'; at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'status.json')
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $node @arguments *> (Join-Path $evidence ("$phase.log"))
  $code = $LASTEXITCODE; $ErrorActionPreference = $old
  $script:results += [pscustomobject]@{ phase=$phase; exitCode=$code; at=(Get-Date).ToUniversalTime().ToString('o') }
  $script:results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'results.json')
  if ($code -ne 0) { throw "Check failed: $phase ($code)" }
}
try {
  Run-Check 'typecheck' @($npm,'run','typecheck:core')
  Run-Check 'lifecycle' @('--test','tests/live-worker-spine.test.mjs')
  Run-Check 'ui' @($npm,'run','test:ui','--','tests-ui/core-screens/spine.test.jsx','tests-ui/core-screens/plan-spine.test.jsx','tests-ui/core-screens/tasks.test.jsx','--maxWorkers=1','--no-file-parallelism','--pool=forks')
  Run-Check 'core' @($npm,'run','test:core','--','core/mcp/board.test.ts','core/host/routes/tasks.test.ts','--maxWorkers=1','--no-file-parallelism','--pool=forks')
  Run-Check 'build' @($npm,'run','build')
  Run-Check 'sites' @($npm,'run','test:sites')
  [pscustomobject]@{ state='passed'; at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'status.json')
} catch {
  [pscustomobject]@{ state='failed'; error=$_.Exception.Message; at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'status.json')
  exit 1
}
