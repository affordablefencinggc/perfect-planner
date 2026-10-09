# Installs one Windows installer (NSIS setup.exe or MSI) silently, smoke-tests the installed app
# through tauri-driver, closes it, uninstalls it and lists anything left behind.
# Every outcome is a check line in <Out>\checks.jsonl; the script never stops at the first failure.
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][ValidateSet("nsis", "msi")][string]$Kind,
  [Parameter(Mandatory)][string]$Out,
  [Parameter(Mandatory)][string]$Folder,
  [Parameter(Mandatory)][string]$NativeDriver
)
$ErrorActionPreference = "Continue"
$label = "windows-$Kind"
function Check($name, $verdict, $seen) { node scripts/release/trial/record-check.mjs $Out $label $name $verdict "$seen" }
function UninstallEntries {
  Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "Perfect Planner*" }
}
function AppProcesses { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like "*Perfect Planner*" -or $_.Path -like "*perfect-planner*") } }

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$log = Join-Path $Out "$label-install.log"

# 1. Silent install.
$sw = [Diagnostics.Stopwatch]::StartNew()
if ($Kind -eq "nsis") { $p = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru }
else { $p = Start-Process msiexec.exe -ArgumentList "/i `"$Installer`" /qn /norestart /l*v `"$log`"" -Wait -PassThru }
$entry = UninstallEntries | Select-Object -First 1
$installDir = if ($entry.InstallLocation) { $entry.InstallLocation.Trim('"') } else { $null }
if (-not $installDir) {
  foreach ($candidate in "$env:LOCALAPPDATA\Perfect Planner", "$env:ProgramFiles\Perfect Planner", "${env:ProgramFiles(x86)}\Perfect Planner") { if (Test-Path $candidate) { $installDir = $candidate; break } }
}
$exe = if ($installDir) { Get-ChildItem $installDir -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "^uninstall" -and $_.Name -notmatch "helper" } | Select-Object -First 1 } else { $null }
if ($p.ExitCode -eq 0 -and $exe) { Check "install" pass "exit 0 in $([int]$sw.Elapsed.TotalSeconds) s; $($exe.FullName); uninstall entry: $([bool]$entry)" }
else { Check "install" fail "exit $($p.ExitCode); install dir '$installDir'; exe '$($exe.FullName)'; uninstall entry: $([bool]$entry)" }
if ($installDir) {
  $files = Get-ChildItem $installDir -Recurse -File -ErrorAction SilentlyContinue
  $helper = $files | Where-Object { $_.Name -like "planner-agent-helper*" }
  Check "installed files" $(if ($helper) { "pass" } else { "fail" }) "$($files.Count) files: $(($files | ForEach-Object { $_.Name }) -join ', '); agent helper sidecar: $(if ($helper) { $helper.Name } else { 'MISSING' })"
}
$lnk = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter "*Perfect Planner*.lnk" -ErrorAction SilentlyContinue
Check "start menu shortcut" $(if ($lnk) { "pass" } else { "fail" }) "$(($lnk | ForEach-Object { $_.FullName }) -join '; ')"

# 2. Smoke test the installed app through tauri-driver.
if ($exe) {
  $driver = Start-Process tauri-driver -ArgumentList "--native-driver `"$NativeDriver`"" -PassThru -RedirectStandardOutput (Join-Path $Out "$label-driver.out.log") -RedirectStandardError (Join-Path $Out "$label-driver.err.log")
  Start-Sleep -Seconds 3
  node scripts/release/smoke-installed-app.mjs --app $exe.FullName --folder $Folder --out $Out --label $label
  Start-Sleep -Seconds 5
  $left = AppProcesses
  Check "no process after close" $(if ($left) { "fail" } else { "pass" }) "$(if ($left) { ($left | ForEach-Object { "$($_.Name) pid $($_.Id)" }) -join ', ' } else { 'none running' })"
  $left | Stop-Process -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $driver.Id -Force -ErrorAction SilentlyContinue
  Get-Process msedgedriver -ErrorAction SilentlyContinue | Stop-Process -Force
}

# 3. Silent uninstall and leftovers.
$entry = UninstallEntries | Select-Object -First 1
if ($Kind -eq "nsis") {
  $un = if ($entry.QuietUninstallString) { $entry.QuietUninstallString } else { "$($entry.UninstallString) /S" }
  $unExe = ($un -replace '^"([^"]+)".*$', '$1')
  $u = Start-Process -FilePath $unExe -ArgumentList "/S" -Wait -PassThru
  Start-Sleep -Seconds 5  # NSIS uninstallers copy themselves to %TEMP% and return before finishing.
} else {
  $u = Start-Process msiexec.exe -ArgumentList "/x `"$Installer`" /qn /norestart /l*v `"$log.uninstall`"" -Wait -PassThru
}
$leftovers = @()
if ($installDir -and (Test-Path $installDir)) { $leftovers += "install dir $installDir ($((Get-ChildItem $installDir -Recurse -File -ErrorAction SilentlyContinue).Count) files)" }
if (UninstallEntries) { $leftovers += "uninstall registry entry" }
$lnk = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:USERPROFILE\Desktop", "$env:PUBLIC\Desktop" -Recurse -Filter "*Perfect Planner*" -ErrorAction SilentlyContinue
if ($lnk) { $leftovers += "shortcuts: $(($lnk | ForEach-Object { $_.FullName }) -join ', ')" }
Check "uninstall program files" $(if ($u.ExitCode -eq 0 -and -not $leftovers) { "pass" } else { "fail" }) "exit $($u.ExitCode); $(if ($leftovers) { 'left: ' + ($leftovers -join '; ') } else { 'nothing left' })"
$data = @("$env:APPDATA\com.perfectplanner.desktop", "$env:LOCALAPPDATA\com.perfectplanner.desktop") | Where-Object { Test-Path $_ }
$dataDesc = ($data | ForEach-Object { "$_ ($((Get-ChildItem $_ -Recurse -File -ErrorAction SilentlyContinue).Count) files)" }) -join '; '
Check "uninstall user data" $(if ($data) { "fail" } else { "pass" }) "$(if ($data) { 'left: ' + $dataDesc } else { 'no app data left' })"
# Start the next installer from a clean slate.
$data | ForEach-Object { Remove-Item $_ -Recurse -Force -ErrorAction SilentlyContinue }
exit 0
