#!/usr/bin/env bash
# Linux installer trial: installs the .deb with apt (which also proves its declared dependencies
# resolve), smoke-tests it through tauri-driver under Xvfb, purges it and lists leftovers; then
# runs the AppImage the same way. Must run inside a D-Bus session with DISPLAY set (see the workflow).
#   scripts/release/trial/trial-linux.sh <artifact dir> <out dir> <project folder> <label prefix>
set -uo pipefail
# This script deletes Perfect Planner data folders (the app's own, after each trial); never run it on a real PC.
[ "${CI:-}" = true ] && [ "${GITHUB_ACTIONS:-}" = true ] || { echo "trial-linux.sh deletes app data and only runs on GitHub Actions" >&2; exit 2; }
dir="$1"; out="$2"; folder="$3"; prefix="$4"
mkdir -p "$out"
# A fresh runner has no git identity; the app's merge needs one (an app finding, see RESULTS.md). The trial sets one so the loop can reach its end.
git config --global user.name "Trial owner"; git config --global user.email "owner@example.invalid"; git config --global commit.gpgsign false
check() { node scripts/release/trial/record-check.mjs "$out" "$1" "$2" "$3" "${4:-}"; }
app_procs() { pgrep -af 'perfect-planner|Perfect Planner|\.AppImage' | grep -v -e pgrep -e trial-linux -e tauri-driver || true; }
user_data() { for d in ~/.local/share/com.perfectplanner.desktop ~/.config/com.perfectplanner.desktop ~/.cache/com.perfectplanner.desktop ~/.local/share/perfect-planner-desktop ~/.cache/perfect-planner-desktop; do [ -e "$d" ] && echo "$d ($(find "$d" -type f | wc -l) files)"; done; }

clean_user_data() { rm -rf ~/.local/share/com.perfectplanner.desktop ~/.config/com.perfectplanner.desktop ~/.cache/com.perfectplanner.desktop ~/.local/share/perfect-planner-desktop ~/.cache/perfect-planner-desktop; }

leftover_report() { # label tag: what a process that outlived the window is doing, and whether it only needs longer to leave
  local label="$1" tag="$2"
  {
    echo "== $tag, 5 s after close"; app_procs
    for pid in $(pgrep -f 'perfect-planner-desktop|desktop-host/node' || true); do
      echo "-- pid $pid"; ps -o pid,ppid,stat,etime,cmd -p "$pid" 2>/dev/null
      echo "threads: $(ls /proc/$pid/task 2>/dev/null | wc -l)"; echo "thread waits: $(cat /proc/$pid/task/*/wchan 2>/dev/null | tr '\n' ' ')"
    done
    echo "windows named Perfect Planner: $(xdotool search --name 'Perfect Planner' 2>/dev/null | wc -l)"
    sleep 30; echo "== $tag, 35 s after close"; app_procs
  } >> "$out/$label-leftover.txt" 2>&1
}

smoke() { # label app
  local label="$1" app="$2"
  tauri-driver > "$out/$label-driver.log" 2>&1 & local driver=$!
  sleep 3
  node scripts/release/trial/smoke-app.mjs --app "$app" --folder "$folder" --out "$out" --label "$label"
  sleep 5
  [ -n "$(app_procs)" ] && leftover_report "$label" "after the smoke"
  # The whole loop through the installed window, on a clean slate and a fresh git folder of its own.
  clean_user_data
  local repo="$RUNNER_TEMP/loop-repo-$label"
  rm -rf "$repo"; mkdir -p "$repo"
  git -C "$repo" init -q -b main && echo "# Pocket notes" > "$repo/README.md" && git -C "$repo" add -A && git -C "$repo" -c user.name=Owner -c user.email=owner@example.invalid -c commit.gpgsign=false commit -q -m Initial
  node scripts/release/trial/loop-app.mjs --app "$app" --repo "$repo" --out "$out" --label "$label" || true
  sleep 5
  local left; left="$(app_procs)"
  if [ -n "$left" ]; then
    leftover_report "$label" "after the loop"
    left="$(app_procs)"
  fi
  if [ -z "$left" ]; then check "$label" "no process after close" pass "none running"; else check "$label" "no process after close" fail "$left"; pkill -9 -f 'perfect-planner|\.AppImage' || true; fi
  kill "$driver" 2>/dev/null; pkill -f WebKitWebDriver 2>/dev/null || true
}

# --- .deb -----------------------------------------------------------------
label="$prefix-deb"
deb="$(readlink -f "$(ls "$dir"/*.deb 2>/dev/null | head -n1)" 2>/dev/null)"
if [ ! -f "$deb" ]; then check "$label" install fail "no .deb in artifact"; else
  pkg="$(dpkg-deb -f "$deb" Package)"
  check "$label" "package metadata" pass "$(dpkg-deb -f "$deb" Package Version Architecture Depends | tr '\n' ' ')"
  if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$deb" > "$out/$label-apt.log" 2>&1; then
    bin="$(dpkg -L "$pkg" | grep -E '^/usr/bin/' | grep -v helper | head -n1)"
    check "$label" install pass "apt installed $pkg; binary $bin; files: $(dpkg -L "$pkg" | grep -vE '/$' | grep -E '^/usr/(bin|lib|share/applications)' | tr '\n' ' ')"
    desktop="$(dpkg -L "$pkg" | grep -E '\.desktop$' | head -n1)"
    if [ -n "$desktop" ] && desktop-file-validate "$desktop" > "$out/$label-desktop-validate.log" 2>&1; then check "$label" "desktop entry" pass "$desktop valid; Exec=$(grep -m1 '^Exec=' "$desktop" | cut -d= -f2-)"
    else check "$label" "desktop entry" fail "${desktop:-no .desktop file}: $(head -c 300 "$out/$label-desktop-validate.log" 2>/dev/null)"; fi
    missing="$(ldd "$bin" | grep 'not found' || true)"
    if [ -z "$missing" ]; then check "$label" "shared libraries" pass "ldd: all resolved"; else check "$label" "shared libraries" fail "$missing"; fi
    smoke "$label" "$bin"
    sudo apt-get purge -y "$pkg" > "$out/$label-purge.log" 2>&1; status=$?
    left="$( (dpkg -L "$pkg" 2>/dev/null | grep -vE '^/(usr|usr/share|usr/bin|usr/lib|usr/share/applications|usr/share/icons.*)$' ; ls /usr/share/applications 2>/dev/null | grep -i perfect; [ -e "$bin" ] && echo "$bin") | tr '\n' ' ')"
    if [ $status -eq 0 ] && [ -z "$left" ]; then check "$label" "uninstall program files" pass "apt purge exit 0; nothing left"; else check "$label" "uninstall program files" fail "exit $status; left: $left"; fi
    data="$(user_data | tr '\n' ' ')"
    if [ -z "$data" ]; then check "$label" "uninstall user data" pass "no app data left"; else check "$label" "uninstall user data" pass "kept by design: $data"; fi
    clean_user_data
  else
    check "$label" install fail "apt-get install failed: $(tail -n 5 "$out/$label-apt.log" | tr '\n' ' ')"
  fi
fi

# --- AppImage -------------------------------------------------------------
label="$prefix-appimage"
appimage="$(ls "$dir"/*.AppImage 2>/dev/null | head -n1)"
if [ -z "$appimage" ]; then check "$label" install fail "no .AppImage in artifact"; else
  chmod +x "$appimage"
  check "$label" install pass "$(basename "$appimage") $(du -h "$appimage" | cut -f1)"
  smoke "$label" "$(readlink -f "$appimage")"
  data="$(user_data | tr '\n' ' ')"
  if [ -z "$data" ]; then check "$label" "uninstall user data" pass "no app data left after deleting the AppImage"; else check "$label" "uninstall user data" pass "kept by design after deleting the AppImage: $data"; fi
fi
exit 0
