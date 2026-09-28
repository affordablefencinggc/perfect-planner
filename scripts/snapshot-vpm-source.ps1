$ErrorActionPreference='Stop'
$sourceRoot='C:\Users\danie\Documents\Codex\2026-08-31\github-plugin-github-openai-curated-remote\outputs\vpm-defense'
$destinationRoot='C:\repos\perfect-planner-cleanroom\integrations\vpm\upstream'
if(Test-Path -LiteralPath $destinationRoot){throw 'Existing snapshot refused; preserve it.'}
$allowedExtensions=@('.rs','.toml','.lock','.json','.ts','.css','.html','.md','.ps1','.mjs','.yml','.yaml','.png','.ico','.rc')
$excludedDirectories=@('.git','target','node_modules','dist','evidence')
$records=[Collections.Generic.List[object]]::new()
$excluded=[Collections.Generic.List[string]]::new()
function Collect-Source([string]$directory){
 foreach($item in Get-ChildItem -LiteralPath $directory -Force){
  $relative=[IO.Path]::GetRelativePath($sourceRoot,$item.FullName)
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked source refused: $relative"}
  if($item.PSIsContainer){if($item.Name -in $excludedDirectories){$excluded.Add($relative);continue};Collect-Source $item.FullName;continue}
  if($item.Name -eq '.npmrc' -or $item.Name -like '.env*' -or ($item.Extension -notin $allowedExtensions -and $item.Name -ne '.gitignore')){$excluded.Add($relative);continue}
  if($item.Length -gt 16MB){throw "Oversize source needs review: $relative"}
  $records.Add([pscustomobject]@{path=$relative.Replace('\','/');bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()})
 }
}
Collect-Source $sourceRoot
New-Item -ItemType Directory -Path $destinationRoot | Out-Null
foreach($record in $records){
 $source=Join-Path $sourceRoot $record.path
 $destination=Join-Path $destinationRoot $record.path
 New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
 Copy-Item -LiteralPath $source -Destination $destination
 if((Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant() -ne $record.sha256 -or (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() -ne $record.sha256){throw 'Snapshot changed; incomplete copy retained for inspection.'}
}
$manifest=@{schemaVersion=1;source=$sourceRoot;destination=$destinationRoot;copiedAtUtc=[DateTime]::UtcNow.ToString('o');files=$records.ToArray();excluded=$excluded.ToArray();sourceBytesUnchanged=$true;malwareScanPerformed=$false;nativeIntegrationVerified=$false}
$manifestPath=Join-Path (Split-Path -Parent $destinationRoot) 'source-manifest.json'
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 6))
Write-Output "Copied and hash-matched $($records.Count) source/asset files. Exclusions: $($excluded.Count). No code executed."
