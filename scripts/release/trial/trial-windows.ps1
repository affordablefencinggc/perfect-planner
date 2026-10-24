# Installs one Windows installer (NSIS setup.exe or MSI) silently, smoke-tests the installed app
# through tauri-driver, closes it, uninstalls it and lists anything left behind.
# Every outcome is a check line in <Out>\checks.jsonl; the script never stops at the first failure.
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][ValidateSet("nsis", "msi")][string]$Kind,
  [Parameter(Mandatory)][string]$Out,
  [Parameter(Mandatory)][string]$Folder,
  [Parameter(Mandatory)][string]$NativeDriver  # msedgedriver.exe matching the WebView2 runtime
)
$ErrorActionPreference = "Continue"
# This script deletes Perfect Planner data folders (the app's own, between trials); never run it on a real PC.
if ($env:CI -ne "true" -or $env:GITHUB_ACTIONS -ne "true") { Write-Error "trial-windows.ps1 deletes app data and only runs on GitHub Actions"; exit 2 }
$label = "windows-$Kind"
function Check($name, $verdict, $seen) { node scripts/release/trial/record-check.mjs $Out $label $name $verdict "$seen" }
function UninstallEntries {
  Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "Perfect Planner*" }
}
function AppProcesses { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like "*Perfect Planner*" -or $_.Path -like "*perfect-planner*") } }

New-Item -ItemType Directory -Force -Path $Out | Out-Null
# A fresh runner has no git identity; the app's merge needs one (an app finding, see RESULTS.md). The trial sets one so the loop can reach its end.
git config --global user.name "Trial owner"; git config --global user.email "owner@example.invalid"; git config --global commit.gpgsign false
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

# 2. Smoke test the installed app. msedgedriver cannot launch this app ("DevToolsActivePort file
# doesn't exist"), so start it like a person would, with WebView2's DevTools port open, and attach.
if ($exe) {
  # Both routes WebView2 documents for extra browser arguments: the environment variable and the
  # per-executable policy key (the policy applies even when the app sets its own arguments).
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
  $policy = "HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
  New-Item -Path $policy -Force | Out-Null
  New-ItemProperty -Path $policy -Name $exe.Name -Value "--remote-debugging-port=9222" -PropertyType String -Force | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $app = Start-Process -FilePath $exe.FullName -PassThru
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  $ready = $null
  for ($i = 0; $i -lt 60 -and -not $ready; $i++) { try { $ready = Invoke-RestMethod http://127.0.0.1:9222/json/version -TimeoutSec 2 } catch { Start-Sleep -Milliseconds 500 } }
  if ($ready) { Check "launch" pass "window up, WebView2 $($ready.Browser) after $([int]$sw.Elapsed.TotalSeconds) s" }
  else {
    $wv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue
    $wvDesc = ($wv | Select-Object -First 3 | ForEach-Object { ($_.CommandLine -replace '\s+', ' ').Substring(0, [Math]::Min(220, $_.CommandLine.Length)) }) -join ' || '
    $port = Get-ChildItem "$env:LOCALAPPDATA\com.perfectplanner.desktop" -Recurse -Filter DevToolsActivePort -ErrorAction SilentlyContinue | Select-Object -First 1
    $windows = Get-Process -Id $app.Id -ErrorAction SilentlyContinue | ForEach-Object { "'$($_.MainWindowTitle)' handle $($_.MainWindowHandle)" }
    Check "launch" fail "no WebView2 DevTools endpoint within 30 s; app alive: $(-not $app.HasExited) (exit $(if ($app.HasExited) { $app.ExitCode } else { '-' })); main window: $windows; msedgewebview2 processes: $(@($wv).Count); DevToolsActivePort file: $(if ($port) { $port.FullName } else { 'none' }); first webview cmdlines: $wvDesc"
  }
  # A desktop screenshot shows what a person would see, whether or not WebDriver can attach.
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $Out "$label-00-desktop.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  } catch { Write-Output "desktop screenshot failed: $_" }
  $driver = Start-Process $NativeDriver -ArgumentList "--port=4444" -PassThru -RedirectStandardOutput (Join-Path $Out "$label-driver.out.log") -RedirectStandardError (Join-Path $Out "$label-driver.err.log")
  Start-Sleep -Seconds 2
  if ($ready) { node scripts/release/trial/smoke-app.mjs --app $exe.FullName --folder $Folder --out $Out --label $label --attach 127.0.0.1:9222 }
  # Close like clicking the window's X, then make sure the app and its children are gone.
  $closed = $false
  $main = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
  if ($main) { [void]$main.CloseMainWindow(); $closed = $main.WaitForExit(15000) } else { $closed = $true }
  Check "close" $(if ($closed) { "pass" } else { "fail" }) "$(if ($main) { if ($closed) { 'window X closed the app' } else { 'still running 15 s after closing the window' } } else { 'app had already exited' })"
  Start-Sleep -Seconds 3
  $left = AppProcesses
  $webviews = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*com.perfectplanner.desktop*" }
  Check "no process after close" $(if ($left -or $webviews) { "fail" } else { "pass" }) "$(if ($left -or $webviews) { (@($left | ForEach-Object { "$($_.Name) pid $($_.Id)" }) + @($webviews | ForEach-Object { "msedgewebview2 pid $($_.ProcessId)" })) -join ', ' } else { 'none running' })"
  $left | Stop-Process -Force -ErrorAction SilentlyContinue
  $webviews | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # The whole loop through the installed window: a clean slate, a fresh git folder, a new app instance.
  if ($ready) {
    @("$env:APPDATA\com.perfectplanner.desktop", "$env:LOCALAPPDATA\com.perfectplanner.desktop") | ForEach-Object { if (Test-Path $_) { Remove-Item $_ -Recurse -Force -ErrorAction SilentlyContinue } }
    $loopRepo = Join-Path $env:RUNNER_TEMP "loop-repo-$label"
    if (Test-Path $loopRepo) { Remove-Item $loopRepo -Recurse -Force }
    New-Item -ItemType Directory -Force $loopRepo | Out-Null
    "# Pocket notes" | Out-File (Join-Path $loopRepo "README.md") -Encoding utf8
    git -C $loopRepo init -q -b main
    git -C $loopRepo add -A
    git -C $loopRepo -c user.name=Owner -c user.email=owner@example.invalid -c commit.gpgsign=false commit -q -m Initial
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
    $app2 = Start-Process -FilePath $exe.FullName -PassThru
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $up = $null
    for ($i = 0; $i -lt 60 -and -not $up; $i++) { try { $up = Invoke-RestMethod http://127.0.0.1:9222/json/version -TimeoutSec 2 } catch { Start-Sleep -Milliseconds 500 } }
    if ($up) { node scripts/release/trial/loop-app.mjs --app $exe.FullName --repo $loopRepo --out $Out --label $label --attach 127.0.0.1:9222 }
    else { Check "loop: window up" fail "no WebView2 DevTools endpoint for the second launch" }
    $main2 = Get-Process -Id $app2.Id -ErrorAction SilentlyContinue
    if ($main2) { [void]$main2.CloseMainWindow(); [void]$main2.WaitForExit(15000) }
    Start-Sleep -Seconds 3
    AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*com.perfectplanner.desktop*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Stop-Process -Id $driver.Id -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $policy -Name $exe.Name -ErrorAction SilentlyContinue
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
# Kept on purpose: the ledger is the person's record. A silent uninstall never offers to remove it.
Check "uninstall user data" "pass" "$(if ($data) { 'kept by design: ' + $dataDesc } else { 'no app data left' })"
# Start the next installer from a clean slate.
$data | ForEach-Object { Remove-Item $_ -Recurse -Force -ErrorAction SilentlyContinue }
exit 0
