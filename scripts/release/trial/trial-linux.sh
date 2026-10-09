#!/usr/bin/env bash
# Linux installer trial: installs the .deb with apt (which also proves its declared dependencies
# resolve), smoke-tests it through tauri-driver under Xvfb, purges it and lists leftovers; then
# runs the AppImage the same way. Must run inside a D-Bus session with DISPLAY set (see the workflow).
#   scripts/release/trial/trial-linux.sh <artifact dir> <out dir> <project folder> <label prefix>
set -uo pipefail
dir="$1"; out="$2"; folder="$3"; prefix="$4"
mkdir -p "$out"
check() { node scripts/release/trial/record-check.mjs "$out" "$1" "$2" "$3" "${4:-}"; }
app_procs() { pgrep -af 'perfect-planner|Perfect Planner|\.AppImage' | grep -v -e pgrep -e trial-linux -e tauri-driver || true; }
user_data() { for d in ~/.local/share/com.perfectplanner.desktop ~/.config/com.perfectplanner.desktop ~/.cache/com.perfectplanner.desktop ~/.local/share/perfect-planner-desktop ~/.cache/perfect-planner-desktop; do [ -e "$d" ] && echo "$d ($(find "$d" -type f | wc -l) files)"; done; }

smoke() { # label app
  local label="$1" app="$2"
  tauri-driver > "$out/$label-driver.log" 2>&1 & local driver=$!
  sleep 3
  node scripts/release/trial/smoke-app.mjs --app "$app" --folder "$folder" --out "$out" --label "$label"
  sleep 5
  local left; left="$(app_procs)"
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
    if [ -z "$data" ]; then check "$label" "uninstall user data" pass "no app data left"; else check "$label" "uninstall user data" fail "left: $data"; fi
    rm -rf ~/.local/share/com.perfectplanner.desktop ~/.config/com.perfectplanner.desktop ~/.cache/com.perfectplanner.desktop ~/.local/share/perfect-planner-desktop ~/.cache/perfect-planner-desktop
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
  if [ -z "$data" ]; then check "$label" "uninstall user data" pass "no app data left after deleting the AppImage"; else check "$label" "uninstall user data" fail "deleting the AppImage leaves: $data"; fi
fi
exit 0
