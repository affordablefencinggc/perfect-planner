## Installer trial ([run](https://github.com/affordablefencinggc/perfect-planner/actions/runs/37938107222))

| Job | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| trial-linux-rpm-37918632579 | 3 | 0 | 0 |
| trial-linux-rpm-37938195577 | 3 | 0 | 0 |
| trial-linux-ubuntu-22.04-37918632579 | 12 | 4 | 0 |
| trial-linux-ubuntu-22.04-37938195577 | 11 | 5 | 0 |
| trial-linux-ubuntu-24.04-37918632579 | 12 | 4 | 0 |
| trial-linux-ubuntu-24.04-37938195577 | 12 | 4 | 0 |
| trial-macos-arm64-37918632579 | 9 | 5 | 1 |
| trial-macos-arm64-37938195577 | 10 | 4 | 1 |
| trial-macos-x64-37918632579 | 9 | 5 | 1 |
| trial-macos-x64-37938195577 | 10 | 4 | 1 |
| trial-windows-37918632579 | 12 | 4 | 0 |
| trial-windows-37938195577 | 18 | 4 | 0 |

| Job | Target | Check | Result | What was seen |
| --- | --- | --- | --- | --- |
| trial-linux-rpm-37918632579 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-58ff834-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-37918632579 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-37918632579 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-rpm-37938195577 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-726eb0d-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-37938195577 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-37938195577 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/share/applications /usr/share/applications/Perfect Planner.desktop |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 732 ms |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index Roster not connected Agent connection · unverified No forecast Collision check unavailable Connect ag" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | smoke run | **FAIL** | POST /session/fb0096a7-8520-42a7-b9e7-3f532c075939/execute/sync -> 500 {"error":"javascript error","message":"Unexpected EOF","stacktrace":""} |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (7 files) |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-58ff834-linux-x64.AppImage 89M |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 682 ms |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index Roster not connected Agent connection · unverified No forecast Collision check unavailable Connect ag" |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | smoke run | **FAIL** | POST /session/42b06309-b2a5-4521-b408-64c10b16e250/execute/sync -> 500 {"error":"javascript error","message":"Unexpected EOF","stacktrace":""} |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37918632579 | ubuntu-22.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (7 files) |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 333 ms |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | smoke run | **FAIL** | POST /session/4af205f9-b236-45a2-b6a9-097fd349fa19/execute/sync -> 500 {"error":"javascript error","message":"Unexpected EOF","stacktrace":""} |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | no process after close | **FAIL** | 4322 /usr/bin/perfect-planner-desktop 4383 /usr/lib/Perfect Planner/desktop-host/node /usr/lib/Perfect Planner/desktop-host/core-host/desktop.mjs |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (24 files) |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-726eb0d-linux-x64.AppImage 128M |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 415 ms |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | smoke run | **FAIL** | POST /session/86f785b1-2850-46aa-a220-cdfb62a3bfa5/execute/sync -> 500 {"error":"javascript error","message":"Unexpected EOF","stacktrace":""} |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37938195577 | ubuntu-22.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (11 files) |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/share/applications /usr/share/applications/Perfect Planner.desktop |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 1669 ms |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index Roster not connected Agent connection · unverified No forecast Collision check unavailable Connect age" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | smoke run | **FAIL** | POST /session/4346116e-7037-4c5e-9281-731255f13bd5/execute/sync -> 500 {"error":"javascript error","message":"Unexpected EOF","stacktrace":""} |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (7 files) |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-58ff834-linux-x64.AppImage 89M |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 431 ms |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index Roster not connected Agent connection · unverified No forecast Collision check unavailable Connect ag" |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | smoke run | **FAIL** | POST /session/963f2f90-daa7-48f0-8b68-6f0b31711fe6/execute/sync -> 500 {"error":"javascript error","message":"Unexpected EOF","stacktrace":""} |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37918632579 | ubuntu-24.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (6 files) |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 2888 ms |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Owner key missing Agent connection · unverified No forecast Collision check unavailable Connect agen" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | smoke run | **FAIL** | POST /session/247e4acc-6a55-4d35-86b8-8092a2bfcadf/execute/sync -> 500 {"error":"javascript error","message":"Unexpected EOF","stacktrace":""} |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (22 files) |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-726eb0d-linux-x64.AppImage 128M |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 522 ms |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday, 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Owner key missing Agent connection · unverified No forecast Collision check unavailable Connect age" |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | smoke run | **FAIL** | POST /session/b0e5882b-730e-41dd-a6b7-c8a6d14efca6/execute/sync -> 500 {"error":"javascript error","message":"Unexpected EOF","stacktrace":""} |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37938195577 | ubuntu-24.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (22 files) |
| trial-macos-arm64-37918632579 | macos-arm64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-arm64-37918632579 | macos-arm64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable arm64; LSMinimumSystemVersion 10.13 |
| trial-macos-arm64-37918632579 | macos-arm64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-arm64-37918632579 | macos-arm64 | code signature | **FAIL** | verify: /Applications/Perfect Planner.app: code has no resources but signature indicates they must be present ; Signature=adhoc TeamIdentifier=not set |
| trial-macos-arm64-37918632579 | macos-arm64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/tmp.auyTl5MRsG/Perfect Planner.app: code has no resources but signature indicates they must be present (a downloaded copy shows 'damaged' or 'unidentified developer'; Developer ID signing + notarization needed) |
| trial-macos-arm64-37918632579 | macos-arm64 | launch | PASS | pid 2649; still running after 12 s: yes |
| trial-macos-arm64-37918632579 | macos-arm64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-arm64-37918632579 | macos-arm64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-arm64-37918632579 | macos-arm64 | settings opens | **FAIL** | no element matching /^settings$/i among 94 labelled elements |
| trial-macos-arm64-37918632579 | macos-arm64 | connect agent shows a line | PASS | line: claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT="<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1" perfect-planner -- node "<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs" |
| trial-macos-arm64-37918632579 | macos-arm64 | connect line runnable as copied | **FAIL** | line still contains <Perfect Planner app data> <path-to-perfect-planner> |
| trial-macos-arm64-37918632579 | macos-arm64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-arm64-37918632579 | macos-arm64 | quits cleanly | PASS | exited within 1 s |
| trial-macos-arm64-37918632579 | macos-arm64 | uninstall program files | PASS | app bundle removed |
| trial-macos-arm64-37918632579 | macos-arm64 | uninstall user data | **FAIL** | ~/Library/Caches/com.perfectplanner.desktop (2 files);~/Library/WebKit/com.perfectplanner.desktop (12 files); |
| trial-macos-arm64-37938195577 | macos-arm64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-arm64-37938195577 | macos-arm64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable arm64; LSMinimumSystemVersion 10.13 |
| trial-macos-arm64-37938195577 | macos-arm64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-arm64-37938195577 | macos-arm64 | code signature | PASS | verify: ok; Signature=adhoc TeamIdentifier=not set |
| trial-macos-arm64-37938195577 | macos-arm64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/tmp.2EkTUTwjA8/Perfect Planner.app: rejected (not notarized: first open needs System Settings > Privacy & Security > Open Anyway) |
| trial-macos-arm64-37938195577 | macos-arm64 | launch | PASS | pid 4544; still running after 12 s: yes |
| trial-macos-arm64-37938195577 | macos-arm64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-arm64-37938195577 | macos-arm64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-arm64-37938195577 | macos-arm64 | settings opens | **FAIL** | no element matching /^settings$/i among 48 labelled elements |
| trial-macos-arm64-37938195577 | macos-arm64 | connect agent shows a line | PASS | line: claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT="<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1" perfect-planner -- node "<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs" |
| trial-macos-arm64-37938195577 | macos-arm64 | connect line runnable as copied | **FAIL** | line still contains <Perfect Planner app data> <path-to-perfect-planner> |
| trial-macos-arm64-37938195577 | macos-arm64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-arm64-37938195577 | macos-arm64 | quits cleanly | PASS | exited within 2 s |
| trial-macos-arm64-37938195577 | macos-arm64 | uninstall program files | PASS | app bundle removed |
| trial-macos-arm64-37938195577 | macos-arm64 | uninstall user data | **FAIL** | ~/Library/Application Support/com.perfectplanner.desktop (1 files);~/Library/Caches/com.perfectplanner.desktop (25 files);~/Library/WebKit/com.perfectplanner.desktop (15 files);~/Library/Logs/com.perfectplanner.desktop (1 files); |
| trial-macos-x64-37918632579 | macos-x64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-x64-37918632579 | macos-x64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable x86_64; LSMinimumSystemVersion 10.13 |
| trial-macos-x64-37918632579 | macos-x64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-x64-37918632579 | macos-x64 | code signature | **FAIL** | verify: /Applications/Perfect Planner.app: code object is not signed at all In architecture: x86_64 ; |
| trial-macos-x64-37918632579 | macos-x64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/20/jp1_0n3n7kndh6rnbqb5344m0000gn/T/tmp.jMmzWkGjMj/Perfect Planner.app: rejected source=no usable signature (a downloaded copy shows 'damaged' or 'unidentified developer'; Developer ID signing + notarization needed) |
| trial-macos-x64-37918632579 | macos-x64 | launch | PASS | pid 7096; still running after 12 s: yes |
| trial-macos-x64-37918632579 | macos-x64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-x64-37918632579 | macos-x64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-x64-37918632579 | macos-x64 | settings opens | **FAIL** | no element matching /^settings$/i among 98 labelled elements |
| trial-macos-x64-37918632579 | macos-x64 | connect agent shows a line | PASS | line: claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT="<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1" perfect-planner -- node "<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs" |
| trial-macos-x64-37918632579 | macos-x64 | connect line runnable as copied | **FAIL** | line still contains <Perfect Planner app data> <path-to-perfect-planner> |
| trial-macos-x64-37918632579 | macos-x64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-x64-37918632579 | macos-x64 | quits cleanly | PASS | exited within 1 s |
| trial-macos-x64-37918632579 | macos-x64 | uninstall program files | PASS | app bundle removed |
| trial-macos-x64-37918632579 | macos-x64 | uninstall user data | **FAIL** | ~/Library/Caches/com.perfectplanner.desktop (2 files);~/Library/WebKit/com.perfectplanner.desktop (12 files); |
| trial-macos-x64-37938195577 | macos-x64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-x64-37938195577 | macos-x64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable x86_64; LSMinimumSystemVersion 10.13 |
| trial-macos-x64-37938195577 | macos-x64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-x64-37938195577 | macos-x64 | code signature | PASS | verify: ok; Signature=adhoc TeamIdentifier=not set |
| trial-macos-x64-37938195577 | macos-x64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/20/jp1_0n3n7kndh6rnbqb5344m0000gn/T/tmp.dvPJZlA78S/Perfect Planner.app: rejected (not notarized: first open needs System Settings > Privacy & Security > Open Anyway) |
| trial-macos-x64-37938195577 | macos-x64 | launch | PASS | pid 1980; still running after 12 s: yes |
| trial-macos-x64-37938195577 | macos-x64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-x64-37938195577 | macos-x64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-x64-37938195577 | macos-x64 | settings opens | **FAIL** | no element matching /^settings$/i among 52 labelled elements |
| trial-macos-x64-37938195577 | macos-x64 | connect agent shows a line | PASS | line: claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT="<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1" perfect-planner -- node "<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs" |
| trial-macos-x64-37938195577 | macos-x64 | connect line runnable as copied | **FAIL** | line still contains <Perfect Planner app data> <path-to-perfect-planner> |
| trial-macos-x64-37938195577 | macos-x64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-x64-37938195577 | macos-x64 | quits cleanly | PASS | exited within 2 s |
| trial-macos-x64-37938195577 | macos-x64 | uninstall program files | PASS | app bundle removed |
| trial-macos-x64-37938195577 | macos-x64 | uninstall user data | **FAIL** | ~/Library/Application Support/com.perfectplanner.desktop (1 files);~/Library/Caches/com.perfectplanner.desktop (33 files);~/Library/WebKit/com.perfectplanner.desktop (16 files);~/Library/Logs/com.perfectplanner.desktop (1 files); |
| trial-windows-37918632579 | windows-nsis | install | PASS | exit 0 in 3 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37918632579 | windows-nsis | installed files | PASS | 3 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe; agent helper sidecar: planner-agent-helper.exe |
| trial-windows-37918632579 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |
| trial-windows-37918632579 | windows-nsis | launch | **FAIL** | no WebView2 DevTools endpoint within 30 s; app alive: True (exit -); main window: 'Perfect Planner' handle 262166; msedgewebview2 processes: 6; DevToolsActivePort file: none; first webview cmdlines: "C:\Program Files (x86)\Microsoft\EdgeWebView\Application\153.0.4234.48\msedgewebview2.exe" --embedde |
| trial-windows-37918632579 | windows-nsis | close | PASS | window X closed the app |
| trial-windows-37918632579 | windows-nsis | no process after close | PASS | none running |
| trial-windows-37918632579 | windows-nsis | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-37918632579 | windows-nsis | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (193 files) |
| trial-windows-37918632579 | windows-msi | install | PASS | exit 0 in 4 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37918632579 | windows-msi | installed files | PASS | 3 files: perfect-planner-desktop.exe, planner-agent-helper.exe, Uninstall Perfect Planner.lnk; agent helper sidecar: planner-agent-helper.exe |
| trial-windows-37918632579 | windows-msi | start menu shortcut | PASS | C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Perfect Planner\Perfect Planner.lnk |
| trial-windows-37918632579 | windows-msi | launch | **FAIL** | no WebView2 DevTools endpoint within 30 s; app alive: True (exit -); main window: 'Perfect Planner' handle 393712; msedgewebview2 processes: 6; DevToolsActivePort file: none; first webview cmdlines: "C:\Program Files (x86)\Microsoft\EdgeWebView\Application\153.0.4234.48\msedgewebview2.exe" --embedde |
| trial-windows-37918632579 | windows-msi | close | PASS | window X closed the app |
| trial-windows-37918632579 | windows-msi | no process after close | PASS | none running |
| trial-windows-37918632579 | windows-msi | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-37918632579 | windows-msi | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (193 files) |
| trial-windows-37938195577 | windows-nsis | install | PASS | exit 0 in 6 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37938195577 | windows-nsis | installed files | PASS | 200 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-IvIFXow1.js, BlueprintWorkspace-CCNJRH9j.js, BlueprintWorkspace-gjSS7_Gq.css, Code.es-C_cVsSaV.js, ComponentPlansWor |
| trial-windows-37938195577 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |
| trial-windows-37938195577 | windows-nsis | launch | PASS | window up, WebView2 Edg/153.0.4234.48 after 3 s |
| trial-windows-37938195577 | windows-nsis | launch | PASS | WebDriver session up after 707 ms |
| trial-windows-37938195577 | windows-nsis | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project facts." |
| trial-windows-37938195577 | windows-nsis | smoke run | **FAIL** | POST /session/ec9fe72f9e38d3fb81662ad5275f8369/execute/sync -> 500 {"error":"javascript error","message":"javascript error: Invalid or unexpected token\n (Session info: MicrosoftEdge=153.0.4234.48)","stacktrace":"\tmsedgedriver!GetHandleVerifier [0x7ff76a061e55+4ca5]\n\tmsedgedriver!(No symbol) [0x7 |
| trial-windows-37938195577 | windows-nsis | close | PASS | window X closed the app |
| trial-windows-37938195577 | windows-nsis | no process after close | PASS | none running |
| trial-windows-37938195577 | windows-nsis | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-37938195577 | windows-nsis | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (0 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (150 files) |
| trial-windows-37938195577 | windows-msi | install | PASS | exit 0 in 4 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37938195577 | windows-msi | installed files | PASS | 200 files: perfect-planner-desktop.exe, planner-agent-helper.exe, Uninstall Perfect Planner.lnk, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-IvIFXow1.js, BlueprintWorkspace-CCNJRH9j.js, BlueprintWorkspace-gjSS7_Gq.css, Code.es-C_cVsSaV.js, C |
| trial-windows-37938195577 | windows-msi | start menu shortcut | PASS | C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Perfect Planner\Perfect Planner.lnk |
| trial-windows-37938195577 | windows-msi | launch | PASS | window up, WebView2 Edg/153.0.4234.48 after 1 s |
| trial-windows-37938195577 | windows-msi | launch | PASS | WebDriver session up after 276 ms |
| trial-windows-37938195577 | windows-msi | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project facts." |
| trial-windows-37938195577 | windows-msi | smoke run | **FAIL** | POST /session/d9658bfe42bab0fae8e6c8cd06b1cca6/execute/sync -> 500 {"error":"javascript error","message":"javascript error: Invalid or unexpected token\n (Session info: MicrosoftEdge=153.0.4234.48)","stacktrace":"\tmsedgedriver!GetHandleVerifier [0x7ff76a061e55+4ca5]\n\tmsedgedriver!(No symbol) [0x7 |
| trial-windows-37938195577 | windows-msi | close | PASS | window X closed the app |
| trial-windows-37938195577 | windows-msi | no process after close | PASS | none running |
| trial-windows-37938195577 | windows-msi | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-37938195577 | windows-msi | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (0 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (150 files) |

125 of 168 checks did not fail across 12 jobs; 43 failed.
