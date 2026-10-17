## Installer trial ([run](https://github.com/affordablefencinggc/perfect-planner/actions/runs/39005589966))

| Job | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| trial-linux-rpm-39001370779 | 3 | 0 | 0 |
| trial-linux-ubuntu-22.04-39001370779 | 20 | 4 | 0 |
| trial-linux-ubuntu-24.04-39001370779 | 20 | 4 | 0 |
| trial-windows-39001370779 | 19 | 7 | 0 |

| Job | Target | Check | Result | What was seen |
| --- | --- | --- | --- | --- |
| trial-linux-rpm-39001370779 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-2aac100-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-39001370779 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-39001370779 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 229 ms |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / no diagnostic errors" |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | connect agent shows a line | PASS | first line: "'/usr/lib/Perfect Planner/desktop-host/node' '/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' --agent claude http://127.0.0.1:41861 '/home/runner/.local/share/com.perfectplanner.desktop/authority/core/projects/default/.perfect-" |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | close | PASS | session closed in 50 ms |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (55 files) |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-2aac100-linux-x64.AppImage 128M |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 281 ms |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / no diagnostic errors" |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | connect agent shows a line | PASS | first line: "'/tmp/.mount_Perfeclphffi/usr/lib/Perfect Planner/desktop-host/node' '/tmp/.mount_Perfeclphffi/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' --agent claude http://127.0.0.1:43035 '/home/runner/.local/share/com.perfectplanner.d" |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | close | PASS | session closed in 49 ms |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-39001370779 | ubuntu-22.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (53 files) |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 2197 ms |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 17 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Roster not connected Agent connection · unverified No forecast Collision check unavailable Connec" |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / no diagnostic errors" |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | connect agent shows a line | PASS | first line: "'/usr/lib/Perfect Planner/desktop-host/node' '/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' --agent claude http://127.0.0.1:34765 '/home/runner/.local/share/com.perfectplanner.desktop/authority/core/projects/default/.perfect-" |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | close | PASS | session closed in 8 ms |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (58 files) |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-2aac100-linux-x64.AppImage 128M |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 416 ms |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / no diagnostic errors" |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | connect agent shows a line | PASS | first line: "'/tmp/.mount_Perfecomfefh/usr/lib/Perfect Planner/desktop-host/node' '/tmp/.mount_Perfecomfefh/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' --agent claude http://127.0.0.1:36543 '/home/runner/.local/share/com.perfectplanner.d" |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | close | PASS | session closed in 50 ms |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-39001370779 | ubuntu-24.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (53 files) |
| trial-windows-39001370779 | windows-nsis | install | PASS | exit 0 in 7 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-39001370779 | windows-nsis | installed files | PASS | 202 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-EVg2bI9D.js, BlueprintWorkspace-BOJUQ_Jg.js, BlueprintWorkspace-QcWZHFF6.css, censusPaths-C80d3pC9.js, Code.es-wvxFB |
| trial-windows-39001370779 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |
| trial-windows-39001370779 | windows-nsis | launch | PASS | window up, WebView2 Edg/154.0.4258.62 after 3 s |
| trial-windows-39001370779 | windows-nsis | launch | PASS | WebDriver session up after 849 ms |
| trial-windows-39001370779 | windows-nsis | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 17 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project fac" |
| trial-windows-39001370779 | windows-nsis | settings opens | **FAIL** | clicked "Settings" but no settings page appeared within the wait; page shows "PP Perfect Planner v0.1 clean-room · Saturday 17 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without i" |
| trial-windows-39001370779 | windows-nsis | open project folder | **FAIL** | dialog: dialog-not-found (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / no diagnostic errors" |
| trial-windows-39001370779 | windows-nsis | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. Connect agent Start a new history for t" |
| trial-windows-39001370779 | windows-nsis | close | PASS | window X closed the app |
| trial-windows-39001370779 | windows-nsis | no process after close | PASS | none running |
| trial-windows-39001370779 | windows-nsis | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-39001370779 | windows-nsis | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (1 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (206 files) |
| trial-windows-39001370779 | windows-msi | install | PASS | exit 0 in 4 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-39001370779 | windows-msi | installed files | PASS | 202 files: perfect-planner-desktop.exe, planner-agent-helper.exe, Uninstall Perfect Planner.lnk, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-EVg2bI9D.js, BlueprintWorkspace-BOJUQ_Jg.js, BlueprintWorkspace-QcWZHFF6.css, censusPaths-C80d3pC9.j |
| trial-windows-39001370779 | windows-msi | start menu shortcut | PASS | C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Perfect Planner\Perfect Planner.lnk |
| trial-windows-39001370779 | windows-msi | launch | PASS | window up, WebView2 Edg/154.0.4258.62 after 1 s |
| trial-windows-39001370779 | windows-msi | launch | PASS | WebDriver session up after 94 ms |
| trial-windows-39001370779 | windows-msi | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 17 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project fac" |
| trial-windows-39001370779 | windows-msi | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rel" |
| trial-windows-39001370779 | windows-msi | open project folder | **FAIL** | dialog: dialog-not-found (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / no diagnostic errors" |
| trial-windows-39001370779 | windows-msi | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. Connect agent Start a new history for t" |
| trial-windows-39001370779 | windows-msi | close | PASS | window X closed the app |
| trial-windows-39001370779 | windows-msi | no process after close | PASS | none running |
| trial-windows-39001370779 | windows-msi | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-39001370779 | windows-msi | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (1 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (206 files) |

62 of 77 checks did not fail across 4 jobs; 15 failed.
