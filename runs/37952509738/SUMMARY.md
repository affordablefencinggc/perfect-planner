## Installer trial ([run](https://github.com/affordablefencinggc/perfect-planner/actions/runs/37952509738))

| Job | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| trial-linux-rpm-37938195577 | 3 | 0 | 0 |
| trial-linux-ubuntu-22.04-37918632579 | 16 | 8 | 0 |
| trial-linux-ubuntu-22.04-37938195577 | 18 | 6 | 0 |
| trial-linux-ubuntu-24.04-37918632579 | 16 | 8 | 0 |
| trial-linux-ubuntu-24.04-37938195577 | 18 | 6 | 0 |
| trial-macos-arm64-37918632579 | 8 | 6 | 1 |
| trial-macos-arm64-37938195577 | 9 | 5 | 1 |
| trial-macos-x64-37918632579 | 8 | 6 | 1 |
| trial-macos-x64-37938195577 | 9 | 5 | 1 |
| trial-windows-37938195577 | 22 | 6 | 0 |

| Job | Target | Check | Result | What was seen |
| --- | --- | --- | --- | --- |
| trial-linux-rpm-37938195577 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-726eb0d-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-37938195577 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-37938195577 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/share/applications /usr/share/applications/Perfect Planner.desktop |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 307 ms |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index Roster not connected Agent connection · unverified No forecast Collision check unavailable Connect ag" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | settings opens | **FAIL** | no Settings control in the top bar or More actions |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app shows: " PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Inde" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | connect agent shows a line | PASS | first line: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-planner -- node \"<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs\"" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | connect lines runnable as copied | **FAIL** | 14 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | close | PASS | session closed in 44 ms |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (6 files) |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-58ff834-linux-x64.AppImage 89M |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 342 ms |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index Roster not connected Agent connection · unverified No forecast Collision check unavailable Connect ag" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | settings opens | **FAIL** | no Settings control in the top bar or More actions |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app shows: " PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Inde" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | connect agent shows a line | PASS | first line: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-planner -- node \"<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs\"" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | connect lines runnable as copied | **FAIL** | 14 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | close | PASS | session closed in 44 ms |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (8 files) |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 612 ms |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Owner key missing Agent connection · unverified No forecast Collision check unavailable Connect age" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | settings opens | PASS | opened via "Settings" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | connect agent shows a line | PASS | first line: "'/usr/lib/Perfect Planner/desktop-host/node' '/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' http://127.0.0.1:41497 '/home/runner/.local/share/com.perfectplanner.desktop/authority/core/projects/default/.perfect-planner/tokens/" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | connect lines runnable as copied | **FAIL** | 15 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | close | PASS | session closed in 46 ms |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (54 files) |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-726eb0d-linux-x64.AppImage 128M |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 664 ms |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Owner key missing Agent connection · unverified No forecast Collision check unavailable Connect age" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | settings opens | PASS | opened via "Settings" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | connect agent shows a line | PASS | first line: "'/tmp/.mount_PerfecLJOMGO/usr/lib/Perfect Planner/desktop-host/node' '/tmp/.mount_PerfecLJOMGO/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' http://127.0.0.1:45081 '/home/runner/.local/share/com.perfectplanner.desktop/authorit" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | connect lines runnable as copied | **FAIL** | 15 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | close | PASS | session closed in 86 ms |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (55 files) |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/share/applications /usr/share/applications/Perfect Planner.desktop |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 2427 ms |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index Roster not connected Agent connection · unverified No forecast Collision check unavailable Connect age" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | settings opens | **FAIL** | no Settings control in the top bar or More actions |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app shows: " PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | connect agent shows a line | PASS | first line: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-planner -- node \"<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs\"" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | connect lines runnable as copied | **FAIL** | 14 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | close | PASS | session closed in 2 ms |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (7 files) |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-58ff834-linux-x64.AppImage 89M |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 399 ms |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index Roster not connected Agent connection · unverified No forecast Collision check unavailable Connect ag" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | settings opens | **FAIL** | no Settings control in the top bar or More actions |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app shows: " PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Inde" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | connect agent shows a line | PASS | first line: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-planner -- node \"<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs\"" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | connect lines runnable as copied | **FAIL** | 14 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | close | PASS | session closed in 45 ms |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (9 files) |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 2129 ms |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Owner key missing Agent connection · unverified No forecast Collision check unavailable Connect agen" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | settings opens | PASS | opened via "Settings" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | connect agent shows a line | PASS | first line: "'/usr/lib/Perfect Planner/desktop-host/node' '/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' http://127.0.0.1:40595 '/home/runner/.local/share/com.perfectplanner.desktop/authority/core/projects/default/.perfect-planner/tokens/" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | connect lines runnable as copied | **FAIL** | 15 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | close | PASS | session closed in 9 ms |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (54 files) |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-726eb0d-linux-x64.AppImage 128M |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 655 ms |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | settings opens | PASS | opened via "Settings" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | connect agent shows a line | PASS | first line: "'/tmp/.mount_PerfecahAOcO/usr/lib/Perfect Planner/desktop-host/node' '/tmp/.mount_PerfecahAOcO/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' http://127.0.0.1:39855 '/home/runner/.local/share/com.perfectplanner.desktop/authorit" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | connect lines runnable as copied | **FAIL** | 15 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | close | PASS | session closed in 60 ms |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (57 files) |
| trial-macos-arm64-37918632579 | macos-arm64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-arm64-37918632579 | macos-arm64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable arm64; LSMinimumSystemVersion 10.13 |
| trial-macos-arm64-37918632579 | macos-arm64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-arm64-37918632579 | macos-arm64 | code signature | **FAIL** | verify: /Applications/Perfect Planner.app: code has no resources but signature indicates they must be present ; Signature=adhoc TeamIdentifier=not set |
| trial-macos-arm64-37918632579 | macos-arm64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/tmp.4sVDg9flzB/Perfect Planner.app: code has no resources but signature indicates they must be present (a downloaded copy shows 'damaged' or 'unidentified developer'; Developer ID signing + notarization needed) |
| trial-macos-arm64-37918632579 | macos-arm64 | launch | PASS | pid 4694; still running after 12 s: yes |
| trial-macos-arm64-37918632579 | macos-arm64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-arm64-37918632579 | macos-arm64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-arm64-37918632579 | macos-arm64 | settings opens | **FAIL** | no element matching /^settings$/i among 94 labelled elements |
| trial-macos-arm64-37918632579 | macos-arm64 | connect agent shows a line | **FAIL** | pressed /^connect agent$/i (first of 1); no element matching /^connect agent$/i among 81 labelled elements; line: claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT="<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1" perfect-planner -- node "<path-to-perfe |
| trial-macos-arm64-37918632579 | macos-arm64 | connect lines runnable as copied | **FAIL** | placeholders shown: <path-to-perfect-planner> <Perfect Planner app data> |
| trial-macos-arm64-37918632579 | macos-arm64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-arm64-37918632579 | macos-arm64 | quits cleanly | PASS | exited within 1 s |
| trial-macos-arm64-37918632579 | macos-arm64 | uninstall program files | PASS | app bundle removed |
| trial-macos-arm64-37918632579 | macos-arm64 | uninstall user data | **FAIL** | ~/Library/Caches/com.perfectplanner.desktop (2 files);~/Library/WebKit/com.perfectplanner.desktop (12 files); |
| trial-macos-arm64-37938195577 | macos-arm64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-arm64-37938195577 | macos-arm64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable arm64; LSMinimumSystemVersion 10.13 |
| trial-macos-arm64-37938195577 | macos-arm64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-arm64-37938195577 | macos-arm64 | code signature | PASS | verify: ok; Signature=adhoc TeamIdentifier=not set |
| trial-macos-arm64-37938195577 | macos-arm64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/tmp.YqDisjzNz3/Perfect Planner.app: rejected (not notarized: first open needs System Settings > Privacy & Security > Open Anyway) |
| trial-macos-arm64-37938195577 | macos-arm64 | launch | PASS | pid 1785; still running after 12 s: yes |
| trial-macos-arm64-37938195577 | macos-arm64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-arm64-37938195577 | macos-arm64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-arm64-37938195577 | macos-arm64 | settings opens | **FAIL** | no element matching /^settings$/i among 48 labelled elements |
| trial-macos-arm64-37938195577 | macos-arm64 | connect agent shows a line | **FAIL** | pressed /^connect agent$/i (first of 1); pressed /^connect agent$/i (last of 1); line: '/Applications/Perfect Planner.app/Contents/Resources/desktop-host/node' '/Applications/Perfect Planner.app/Contents/Resources/desktop-host/core-host/connect.mjs' http://127.0.0.1:49190 '/Users/runner/Library/Appl |
| trial-macos-arm64-37938195577 | macos-arm64 | connect lines runnable as copied | **FAIL** | placeholders shown: <path-to-perfect-planner> <Perfect Planner app data> |
| trial-macos-arm64-37938195577 | macos-arm64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-arm64-37938195577 | macos-arm64 | quits cleanly | PASS | exited within 2 s |
| trial-macos-arm64-37938195577 | macos-arm64 | uninstall program files | PASS | app bundle removed |
| trial-macos-arm64-37938195577 | macos-arm64 | uninstall user data | **FAIL** | ~/Library/Application Support/com.perfectplanner.desktop (2 files);~/Library/Caches/com.perfectplanner.desktop (25 files);~/Library/WebKit/com.perfectplanner.desktop (15 files);~/Library/Logs/com.perfectplanner.desktop (1 files); |
| trial-macos-x64-37918632579 | macos-x64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-x64-37918632579 | macos-x64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable x86_64; LSMinimumSystemVersion 10.13 |
| trial-macos-x64-37918632579 | macos-x64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-x64-37918632579 | macos-x64 | code signature | **FAIL** | verify: /Applications/Perfect Planner.app: code object is not signed at all In architecture: x86_64 ; |
| trial-macos-x64-37918632579 | macos-x64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/20/jp1_0n3n7kndh6rnbqb5344m0000gn/T/tmp.t0KYPqEsfQ/Perfect Planner.app: rejected source=no usable signature (a downloaded copy shows 'damaged' or 'unidentified developer'; Developer ID signing + notarization needed) |
| trial-macos-x64-37918632579 | macos-x64 | launch | PASS | pid 23042; still running after 12 s: yes |
| trial-macos-x64-37918632579 | macos-x64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-x64-37918632579 | macos-x64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-x64-37918632579 | macos-x64 | settings opens | **FAIL** | no element matching /^settings$/i among 98 labelled elements |
| trial-macos-x64-37918632579 | macos-x64 | connect agent shows a line | **FAIL** | pressed /^connect agent$/i (first of 1); no element matching /^connect agent$/i among 81 labelled elements; line: claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT="<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1" perfect-planner -- node "<path-to-perfe |
| trial-macos-x64-37918632579 | macos-x64 | connect lines runnable as copied | **FAIL** | placeholders shown: <path-to-perfect-planner> <Perfect Planner app data> |
| trial-macos-x64-37918632579 | macos-x64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-x64-37918632579 | macos-x64 | quits cleanly | PASS | exited within 1 s |
| trial-macos-x64-37918632579 | macos-x64 | uninstall program files | PASS | app bundle removed |
| trial-macos-x64-37918632579 | macos-x64 | uninstall user data | **FAIL** | ~/Library/Caches/com.perfectplanner.desktop (2 files);~/Library/WebKit/com.perfectplanner.desktop (12 files); |
| trial-macos-x64-37938195577 | macos-x64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-x64-37938195577 | macos-x64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable x86_64; LSMinimumSystemVersion 10.13 |
| trial-macos-x64-37938195577 | macos-x64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-x64-37938195577 | macos-x64 | code signature | PASS | verify: ok; Signature=adhoc TeamIdentifier=not set |
| trial-macos-x64-37938195577 | macos-x64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/20/jp1_0n3n7kndh6rnbqb5344m0000gn/T/tmp.qwjSwJ0ohN/Perfect Planner.app: rejected (not notarized: first open needs System Settings > Privacy & Security > Open Anyway) |
| trial-macos-x64-37938195577 | macos-x64 | launch | PASS | pid 1360; still running after 12 s: yes |
| trial-macos-x64-37938195577 | macos-x64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-x64-37938195577 | macos-x64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-x64-37938195577 | macos-x64 | settings opens | **FAIL** | no element matching /^settings$/i among 52 labelled elements |
| trial-macos-x64-37938195577 | macos-x64 | connect agent shows a line | **FAIL** | pressed /^connect agent$/i (first of 1); pressed /^connect agent$/i (last of 1); line: '/Applications/Perfect Planner.app/Contents/Resources/desktop-host/node' '/Applications/Perfect Planner.app/Contents/Resources/desktop-host/core-host/connect.mjs' http://127.0.0.1:49187 '/Users/runner/Library/Appl |
| trial-macos-x64-37938195577 | macos-x64 | connect lines runnable as copied | **FAIL** | placeholders shown: <path-to-perfect-planner> <Perfect Planner app data> |
| trial-macos-x64-37938195577 | macos-x64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-x64-37938195577 | macos-x64 | quits cleanly | PASS | exited within 1 s |
| trial-macos-x64-37938195577 | macos-x64 | uninstall program files | PASS | app bundle removed |
| trial-macos-x64-37938195577 | macos-x64 | uninstall user data | **FAIL** | ~/Library/Application Support/com.perfectplanner.desktop (2 files);~/Library/Caches/com.perfectplanner.desktop (33 files);~/Library/WebKit/com.perfectplanner.desktop (15 files);~/Library/Logs/com.perfectplanner.desktop (1 files); |
| trial-windows-37938195577 | windows-nsis | install | PASS | exit 0 in 5 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37938195577 | windows-nsis | installed files | PASS | 200 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-IvIFXow1.js, BlueprintWorkspace-CCNJRH9j.js, BlueprintWorkspace-gjSS7_Gq.css, Code.es-C_cVsSaV.js, ComponentPlansWor |
| trial-windows-37938195577 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |
| trial-windows-37938195577 | windows-nsis | launch | PASS | window up, WebView2 Edg/153.0.4234.48 after 3 s |
| trial-windows-37938195577 | windows-nsis | launch | PASS | WebDriver session up after 756 ms |
| trial-windows-37938195577 | windows-nsis | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project facts." |
| trial-windows-37938195577 | windows-nsis | settings opens | PASS | opened via "Settings" |
| trial-windows-37938195577 | windows-nsis | open project folder | **FAIL** | dialog: dialog-not-found (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-windows-37938195577 | windows-nsis | connect agent shows a line | PASS | first line: "& 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\node.exe' 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\core-host\\connect.mjs' http://127.0.0.1:65529 'C:\\Users\\runneradmin\\AppData\\Roaming\\com.perfectpla" |
| trial-windows-37938195577 | windows-nsis | connect lines runnable as copied | **FAIL** | 15 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-windows-37938195577 | windows-nsis | close | PASS | window X closed the app |
| trial-windows-37938195577 | windows-nsis | no process after close | PASS | none running |
| trial-windows-37938195577 | windows-nsis | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-37938195577 | windows-nsis | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (2 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (201 files) |
| trial-windows-37938195577 | windows-msi | install | PASS | exit 0 in 3 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37938195577 | windows-msi | installed files | PASS | 200 files: perfect-planner-desktop.exe, planner-agent-helper.exe, Uninstall Perfect Planner.lnk, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-IvIFXow1.js, BlueprintWorkspace-CCNJRH9j.js, BlueprintWorkspace-gjSS7_Gq.css, Code.es-C_cVsSaV.js, C |
| trial-windows-37938195577 | windows-msi | start menu shortcut | PASS | C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Perfect Planner\Perfect Planner.lnk |
| trial-windows-37938195577 | windows-msi | launch | PASS | window up, WebView2 Edg/153.0.4234.48 after 1 s |
| trial-windows-37938195577 | windows-msi | launch | PASS | WebDriver session up after 110 ms |
| trial-windows-37938195577 | windows-msi | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project facts." |
| trial-windows-37938195577 | windows-msi | settings opens | PASS | opened via "Settings" |
| trial-windows-37938195577 | windows-msi | open project folder | **FAIL** | dialog: dialog-not-found (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-windows-37938195577 | windows-msi | connect agent shows a line | PASS | first line: "& 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\node.exe' 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\core-host\\connect.mjs' http://127.0.0.1:52161 'C:\\Users\\runneradmin\\AppData\\Roaming\\com.perfectpla" |
| trial-windows-37938195577 | windows-msi | connect lines runnable as copied | **FAIL** | 15 copyable block(s); with placeholders: "claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=\"<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1\" perfect-plann" \| "<path-to-perfect-planner>" |
| trial-windows-37938195577 | windows-msi | close | PASS | window X closed the app |
| trial-windows-37938195577 | windows-msi | no process after close | PASS | none running |
| trial-windows-37938195577 | windows-msi | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-37938195577 | windows-msi | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (2 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (198 files) |

131 of 187 checks did not fail across 10 jobs; 56 failed.
