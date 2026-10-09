#!/usr/bin/env bash
# macOS installer trial. There is no WebDriver for WKWebView, so this checks what a person would
# hit: Gatekeeper's verdict on a downloaded (quarantined) copy, that the app launches and puts a
# window up, a screenshot of it, that it quits cleanly, and what dragging it to the Trash leaves.
# UI checks go through the macOS accessibility tree when the runner allows it, else are SKIPPED.
#   scripts/release/trial/trial-macos.sh <artifact dir> <out dir> <project folder> <label>
set -uo pipefail
dir="$1"; out="$2"; folder="$3"; label="$4"
mkdir -p "$out"
check() { node scripts/release/trial/record-check.mjs "$out" "$label" "$1" "$2" "${3:-}"; }
bundle_id=com.perfectplanner.desktop

dmg="$(ls "$dir"/*.dmg 2>/dev/null | head -n1)"
[ -z "$dmg" ] && { check install fail "no .dmg in artifact"; exit 0; }
mnt="$(mktemp -d)"
if ! hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" > "$out/$label-hdiutil.log" 2>&1; then
  check install fail "hdiutil attach failed: $(tail -n 3 "$out/$label-hdiutil.log" | tr '\n' ' ')"; exit 0
fi
src_app="$(ls -d "$mnt"/*.app | head -n1)"
check "dmg contents" "$([ -n "$src_app" ] && [ -L "$mnt/Applications" ] && echo pass || echo fail)" "$(ls "$mnt" | tr '\n' ' ') (Applications shortcut: $([ -L "$mnt/Applications" ] && echo yes || echo no))"
app="/Applications/$(basename "$src_app")"
rm -rf "$app"; ditto "$src_app" "$app"; hdiutil detach "$mnt" -quiet
exe="$app/Contents/MacOS/$(defaults read "$app/Contents/Info" CFBundleExecutable)"
check install pass "$app; $(file -b "$exe" | head -c 120); LSMinimumSystemVersion $(defaults read "$app/Contents/Info" LSMinimumSystemVersion 2>/dev/null || echo unset)"
helper="$(ls "$app/Contents/MacOS" | grep -i helper || true)"
check "installed files" "$([ -n "$helper" ] && echo pass || echo fail)" "Contents/MacOS: $(ls "$app/Contents/MacOS" | tr '\n' ' ')"

sig="$(codesign -dv "$app" 2>&1 | grep -E 'Signature|TeamIdentifier|Authority' | tr '\n' ' ')"
codesign --verify --deep --strict "$app" > "$out/$label-codesign.log" 2>&1 && verify=ok || verify="$(tail -n 2 "$out/$label-codesign.log" | tr '\n' ' ')"
check "code signature" "$([ "$verify" = ok ] && echo pass || echo fail)" "verify: $verify; $sig"
# Simulate a browser download: quarantine a copy and ask Gatekeeper what it would do on first open.
q="$(mktemp -d)/$(basename "$app")"; ditto "$app" "$q"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" "$q"
gk="$(spctl --assess --type execute -vv "$q" 2>&1 | tr '\n' ' ')"
case "$gk" in *accepted*) check "gatekeeper (downloaded copy)" pass "$gk";; *) check "gatekeeper (downloaded copy)" fail "$gk";; esac
rm -rf "$(dirname "$q")"

# Launch the installed copy (not quarantined, as after a person clicks Open Anyway).
open -a "$app"
pid=""; for i in $(seq 1 30); do pid="$(pgrep -f "$exe" | head -n1)"; [ -n "$pid" ] && break; sleep 1; done
if [ -z "$pid" ]; then check launch fail "no process 30 s after open -a"; log show --last 2m --predicate "process == \"$(basename "$exe")\"" > "$out/$label-unified.log" 2>&1; exit 0; fi
sleep 12
alive="$(pgrep -f "$exe" | head -n1)"
check launch "$([ -n "$alive" ] && echo pass || echo fail)" "pid $pid; still running after 12 s: $([ -n "$alive" ] && echo yes || echo no)"
screencapture -x "$out/$label-01-first-run.png" 2>"$out/$label-screencapture.log" || true

# Accessibility probe: windows + the WebView's AX tree. GitHub's macOS images usually allow it.
ax() { osascript -l JavaScript scripts/release/trial/macos-ax.js "$@" 2>&1; }
windows="$(ax windows "$bundle_id")"
case "$windows" in
  windows:*) check "window shown" "$(echo "$windows" | grep -q 'count=0' && echo fail || echo pass)" "$windows";;
  *) check "window shown" skip "accessibility not available on this runner: $(echo "$windows" | head -c 200)";;
esac
if echo "$windows" | grep -q '^windows:'; then
  text="$(ax text "$bundle_id")"
  echo "$text" > "$out/$label-ax-text.txt"
  if echo "$text" | grep -qiE 'Bring in your existing app|Drop your app|Choose app folder'; then check "first-run screen" pass "$(echo "$text" | tr '\n' ' ' | head -c 220)"
  else check "first-run screen" fail "AX text: $(echo "$text" | tr '\n' ' ' | head -c 220)"; fi
  r="$(ax press "$bundle_id" '^settings$' )"; sleep 2; screencapture -x "$out/$label-02-settings.png" || true
  t="$(ax text "$bundle_id")"
  if echo "$r" | grep -q pressed && echo "$t" | grep -qiE 'keychain|reviewer key|preferences'; then check "settings opens" pass "$r"; else check "settings opens" fail "$r"; fi
  ax key "$bundle_id" escape >/dev/null
  r="$(ax press "$bundle_id" '^connect agent$')"; sleep 3; screencapture -x "$out/$label-04-connect-agent.png" || true
  t="$(ax text "$bundle_id")"; echo "$t" > "$out/$label-ax-connect.txt"
  line="$(echo "$t" | grep -E 'npx |claude mcp|node |perfect-planner' | head -n1)"
  err="$(echo "$t" | grep -iE "couldn't|could not|failed|unavailable|not running" | head -n1)"
  if echo "$r" | grep -q pressed && [ -n "$line" ] && [ -z "$err" ]; then check "connect agent shows a line" pass "line: $line"
  else check "connect agent shows a line" fail "${r}; line: ${line:-none}; panel says: ${err:-$(echo "$t" | tr '\n' ' ' | head -c 200)}"; fi
  check "open project folder" skip "native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux"
else
  for name in "first-run screen" "settings opens" "connect agent shows a line" "open project folder"; do check "$name" skip "needs accessibility access, not granted on this runner"; done
fi

# Quit like a person (Cmd+Q via Apple Events) and confirm the process and its helpers go away.
osascript -e "tell application id \"$bundle_id\" to quit" > "$out/$label-quit.log" 2>&1
gone=""; for i in $(seq 1 20); do pgrep -f "$app" >/dev/null || { gone=yes; break; }; sleep 1; done
check "quits cleanly" "$([ -n "$gone" ] && echo pass || echo fail)" "$([ -n "$gone" ] && echo "exited within ${i} s" || echo "still running: $(pgrep -af "$app" | tr '\n' ' ')")"
pkill -9 -f "$app" 2>/dev/null || true

# "Uninstall" on macOS is dragging the app to the Trash; list what that leaves in ~/Library.
rm -rf "$app"
data="$(for d in "$HOME/Library/Application Support/$bundle_id" "$HOME/Library/Caches/$bundle_id" "$HOME/Library/WebKit/$bundle_id" "$HOME/Library/Preferences/$bundle_id.plist" "$HOME/Library/Saved Application State/$bundle_id.savedState" "$HOME/Library/HTTPStorages/$bundle_id" "$HOME/Library/Logs/$bundle_id"; do [ -e "$d" ] && echo "${d/#$HOME/~} ($(find "$d" -type f | wc -l | tr -d ' ') files)"; done | tr '\n' ';')"
check "uninstall program files" "$([ ! -e "$app" ] && echo pass || echo fail)" "app bundle removed"
check "uninstall user data" "$([ -z "$data" ] && echo pass || echo fail)" "${data:-no app data left}"
exit 0
