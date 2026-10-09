## Installer trial ([run](https://github.com/affordablefencinggc/perfect-planner/actions/runs/37954163084))

| Job | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| trial-linux-rpm-37954032842 | 3 | 0 | 0 |
| trial-linux-ubuntu-22.04-37954032842 | 20 | 4 | 0 |
| trial-linux-ubuntu-24.04-37954032842 | 20 | 4 | 0 |
| trial-macos-arm64-37954032842 | 11 | 3 | 1 |
| trial-windows-37954032842 | 19 | 4 | 0 |

| Job | Target | Check | Result | What was seen |
| --- | --- | --- | --- | --- |
| trial-linux-rpm-37954032842 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-6a5c0a8-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-37954032842 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-37954032842 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 311 ms |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | settings opens | PASS | opened via "Settings" |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | connect agent shows a line | PASS | first line: "'/usr/lib/Perfect Planner/desktop-host/node' '/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' http://127.0.0.1:33811 '/home/runner/.local/share/com.perfectplanner.desktop/authority/core/projects/default/.perfect-planner/tokens/" |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | close | PASS | session closed in 46 ms |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (53 files) |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-6a5c0a8-linux-x64.AppImage 128M |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 354 ms |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | settings opens | PASS | opened via "Settings" |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | connect agent shows a line | PASS | first line: "'/tmp/.mount_PerfecDmALbF/usr/lib/Perfect Planner/desktop-host/node' '/tmp/.mount_PerfecDmALbF/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' http://127.0.0.1:41789 '/home/runner/.local/share/com.perfectplanner.desktop/authorit" |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | close | PASS | session closed in 45 ms |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-37954032842 | ubuntu-22.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (55 files) |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 1596 ms |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Owner key missing Agent connection · unverified No forecast Collision check unavailable Connect agen" |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | settings opens | PASS | opened via "Settings" |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | connect agent shows a line | PASS | first line: "'/usr/lib/Perfect Planner/desktop-host/node' '/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' http://127.0.0.1:38499 '/home/runner/.local/share/com.perfectplanner.desktop/authority/core/projects/default/.perfect-planner/tokens/" |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | close | PASS | session closed in 11 ms |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (56 files) |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-6a5c0a8-linux-x64.AppImage 128M |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 587 ms |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | settings opens | PASS | opened via "Settings" |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | connect agent shows a line | PASS | first line: "'/tmp/.mount_PerfechpICod/usr/lib/Perfect Planner/desktop-host/node' '/tmp/.mount_PerfechpICod/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' http://127.0.0.1:36699 '/home/runner/.local/share/com.perfectplanner.desktop/authorit" |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | close | PASS | session closed in 48 ms |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-37954032842 | ubuntu-24.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (53 files) |
| trial-macos-arm64-37954032842 | macos-arm64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-arm64-37954032842 | macos-arm64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable arm64; LSMinimumSystemVersion 10.13 |
| trial-macos-arm64-37954032842 | macos-arm64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-arm64-37954032842 | macos-arm64 | code signature | PASS | verify: ok; Signature=adhoc TeamIdentifier=not set |
| trial-macos-arm64-37954032842 | macos-arm64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/tmp.fT9OloH77z/Perfect Planner.app: rejected (not notarized: first open needs System Settings > Privacy & Security > Open Anyway) |
| trial-macos-arm64-37954032842 | macos-arm64 | launch | PASS | pid 3756; still running after 12 s: yes |
| trial-macos-arm64-37954032842 | macos-arm64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-arm64-37954032842 | macos-arm64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-arm64-37954032842 | macos-arm64 | settings opens | **FAIL** | no element matching /^settings$/i among 48 labelled elements |
| trial-macos-arm64-37954032842 | macos-arm64 | connect agent shows a line | PASS | line: '/Applications/Perfect Planner.app/Contents/Resources/desktop-host/node' '/Applications/Perfect Planner.app/Contents/Resources/desktop-host/core-host/connect.mjs' http://127.0.0.1:49185 '/Users/runner/Library/Application Support/com.perfectplanner.desktop/authority/core/projects/default/.perfe |
| trial-macos-arm64-37954032842 | macos-arm64 | connect lines runnable as copied | PASS | 1 lines, no placeholders |
| trial-macos-arm64-37954032842 | macos-arm64 | open project folder | SKIP | native NSOpenPanel is not driven on macOS runners; covered on Windows and Linux |
| trial-macos-arm64-37954032842 | macos-arm64 | quits cleanly | PASS | exited within 2 s |
| trial-macos-arm64-37954032842 | macos-arm64 | uninstall program files | PASS | app bundle removed |
| trial-macos-arm64-37954032842 | macos-arm64 | uninstall user data | **FAIL** | ~/Library/Application Support/com.perfectplanner.desktop (2 files);~/Library/Caches/com.perfectplanner.desktop (25 files);~/Library/WebKit/com.perfectplanner.desktop (15 files);~/Library/Logs/com.perfectplanner.desktop (1 files); |
| trial-windows-37954032842 | windows-nsis | install | PASS | exit 0 in 7 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37954032842 | windows-nsis | installed files | PASS | 200 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-CHN16p0G.js, BlueprintWorkspace-C2p8JUVs.js, BlueprintWorkspace-gjSS7_Gq.css, Code.es-CTJ_jgka.js, ComponentPlansWor |
| trial-windows-37954032842 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |
| trial-windows-37954032842 | windows-nsis | launch | PASS | window up, WebView2 Edg/153.0.4234.48 after 3 s |
| trial-windows-37954032842 | windows-nsis | launch | PASS | WebDriver session up after 939 ms |
| trial-windows-37954032842 | windows-nsis | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Friday 9 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project facts." |
| trial-windows-37954032842 | windows-nsis | settings opens | PASS | opened via "Settings" |
| trial-windows-37954032842 | windows-nsis | open project folder | **FAIL** | dialog: dialog-not-found (exit 2); app never showed "trial-sample-app" or a read-only scan step |
| trial-windows-37954032842 | windows-nsis | connect agent shows a line | PASS | first line: "& 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\node.exe' 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\core-host\\connect.mjs' http://127.0.0.1:60840 'C:\\Users\\runneradmin\\AppData\\Roaming\\com.perfectpla" |
| trial-windows-37954032842 | windows-nsis | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-windows-37954032842 | windows-nsis | close | PASS | window X closed the app |
| trial-windows-37954032842 | windows-nsis | no process after close | PASS | none running |
| trial-windows-37954032842 | windows-nsis | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-37954032842 | windows-nsis | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (2 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (198 files) |
| trial-windows-37954032842 | windows-msi | install | PASS | exit 0 in 4 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37954032842 | windows-msi | installed files | PASS | 200 files: perfect-planner-desktop.exe, planner-agent-helper.exe, Uninstall Perfect Planner.lnk, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-CHN16p0G.js, BlueprintWorkspace-C2p8JUVs.js, BlueprintWorkspace-gjSS7_Gq.css, Code.es-CTJ_jgka.js, C |
| trial-windows-37954032842 | windows-msi | start menu shortcut | PASS | C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Perfect Planner\Perfect Planner.lnk |
| trial-windows-37954032842 | windows-msi | launch | PASS | window up, WebView2 Edg/153.0.4234.48 after 1 s |
| trial-windows-37954032842 | windows-msi | smoke run | **FAIL** | fetch failed |
| trial-windows-37954032842 | windows-msi | close | PASS | window X closed the app |
| trial-windows-37954032842 | windows-msi | no process after close | PASS | none running |
| trial-windows-37954032842 | windows-msi | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-37954032842 | windows-msi | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (0 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (150 files) |

74 of 89 checks did not fail across 5 jobs; 15 failed.
