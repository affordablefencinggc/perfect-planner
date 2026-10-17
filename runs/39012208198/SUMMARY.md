## Installer trial ([run](https://github.com/affordablefencinggc/perfect-planner/actions/runs/39012208198))

| Job | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| trial-linux-rpm-39011557246 | 3 | 0 | 0 |
| trial-linux-ubuntu-22.04-39011557246 | 38 | 6 | 0 |
| trial-linux-ubuntu-24.04-39011557246 | 38 | 6 | 0 |
| trial-windows-39011557246 | 34 | 8 | 0 |

| Job | Target | Check | Result | What was seen |
| --- | --- | --- | --- | --- |
| trial-linux-rpm-39011557246 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-113afb6-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-39011557246 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-39011557246 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 1257 ms |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / 2 diagnostic errors" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | close | PASS | session closed in 47 ms |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-22.04-deb |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (355 chars, private key not logged) |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-7f565b39 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-7f565b39 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | stand-in worker builds, commits, attaches proof | PASS | proof attached at f0126fe1f5a7 |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | merge into main | PASS | main now holds src/notes.mjs (2cebd1a Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (65 files) |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-113afb6-linux-x64.AppImage 128M |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 518 ms |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / 2 diagnostic errors" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | close | PASS | session closed in 46 ms |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-22.04-appimage |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (408 chars, private key not logged) |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-bb6c2334 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-bb6c2334 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | stand-in worker builds, commits, attaches proof | PASS | proof attached at 031b9dcef00b |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | merge into main | PASS | main now holds src/notes.mjs (fba08d5 Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-39011557246 | ubuntu-22.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (67 files) |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 551 ms |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 17 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Roster not connected Agent connection · unverified No forecast Collision check unavailable Connec" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / 2 diagnostic errors" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | close | PASS | session closed in 3 ms |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-24.04-deb |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (355 chars, private key not logged) |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-9d8ec967 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-9d8ec967 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | stand-in worker builds, commits, attaches proof | PASS | proof attached at a76dcc1cc3b3 |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | merge into main | PASS | main now holds src/notes.mjs (ece4fcb Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-deb | uninstall user data | **FAIL** | left: /home/runner/.local/share/com.perfectplanner.desktop (68 files) |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-113afb6-linux-x64.AppImage 128M |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 362 ms |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | open project folder | **FAIL** | dialog: xdg-desktop-portal-gtk (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / 2 diagnostic errors" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | close | PASS | session closed in 44 ms |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-24.04-appimage |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (408 chars, private key not logged) |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-c1c823b8 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-c1c823b8 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | stand-in worker builds, commits, attaches proof | PASS | proof attached at b4f27a90fcf0 |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | merge into main | PASS | main now holds src/notes.mjs (bc3ad1b Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-39011557246 | ubuntu-24.04-appimage | uninstall user data | **FAIL** | deleting the AppImage leaves: /home/runner/.local/share/com.perfectplanner.desktop (65 files) |
| trial-windows-39011557246 | windows-nsis | install | PASS | exit 0 in 6 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-39011557246 | windows-nsis | installed files | PASS | 202 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-ByUDcKSh.js, BlueprintWorkspace-bI7uR7gf.js, BlueprintWorkspace-QcWZHFF6.css, censusPaths-C80d3pC9.js, Code.es-CB8Gi |
| trial-windows-39011557246 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |
| trial-windows-39011557246 | windows-nsis | launch | PASS | window up, WebView2 Edg/154.0.4258.62 after 3 s |
| trial-windows-39011557246 | windows-nsis | launch | PASS | WebDriver session up after 1206 ms |
| trial-windows-39011557246 | windows-nsis | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 17 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project fac" |
| trial-windows-39011557246 | windows-nsis | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rel" |
| trial-windows-39011557246 | windows-nsis | open project folder | **FAIL** | dialog: dialog-not-found (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / no diagnostic errors" |
| trial-windows-39011557246 | windows-nsis | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-windows-39011557246 | windows-nsis | close | PASS | window X closed the app |
| trial-windows-39011557246 | windows-nsis | no process after close | PASS | none running |
| trial-windows-39011557246 | windows-nsis | plan: idea and recommended answers | PASS | 40 recommendations used; no blocking questions |
| trial-windows-39011557246 | windows-nsis | plan: approve | PASS | Plan approved |
| trial-windows-39011557246 | windows-nsis | open git folder in Tasks | PASS | Workers branch from D:\a\_temp\loop-repo-windows-nsis |
| trial-windows-39011557246 | windows-nsis | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-windows-39011557246 | windows-nsis | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (405 chars, private key not logged) |
| trial-windows-39011557246 | windows-nsis | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-b7461d87 checked in as worker on T-1; window shows "Test to approve" |
| trial-windows-39011557246 | windows-nsis | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Test approved \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-b7461d87 (claude-trial) · approved by you (owner) |
| trial-windows-39011557246 | windows-nsis | stand-in worker builds, commits, attaches proof | **FAIL** | claim_task: REFUSED: T-1 cannot be claimed: T-1's test has not been run on the current code yet. (RULE) Window says: Test approved [window 1008x681; visible buttons: PP Perfect Planner v0.1 clea \| Home \| 01Define \| 02Coordinate \| 03Build \| 04Prove \| 05Release \| Index \| Connect agent \| More  |
| trial-windows-39011557246 | windows-nsis | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-39011557246 | windows-nsis | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (13 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (209 files) |
| trial-windows-39011557246 | windows-msi | install | PASS | exit 0 in 4 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-39011557246 | windows-msi | installed files | PASS | 202 files: perfect-planner-desktop.exe, planner-agent-helper.exe, Uninstall Perfect Planner.lnk, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-ByUDcKSh.js, BlueprintWorkspace-bI7uR7gf.js, BlueprintWorkspace-QcWZHFF6.css, censusPaths-C80d3pC9.j |
| trial-windows-39011557246 | windows-msi | start menu shortcut | PASS | C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Perfect Planner\Perfect Planner.lnk |
| trial-windows-39011557246 | windows-msi | launch | PASS | window up, WebView2 Edg/154.0.4258.62 after 1 s |
| trial-windows-39011557246 | windows-msi | launch | PASS | WebDriver session up after 77 ms |
| trial-windows-39011557246 | windows-msi | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 17 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project fac" |
| trial-windows-39011557246 | windows-msi | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rel" |
| trial-windows-39011557246 | windows-msi | open project folder | **FAIL** | dialog: dialog-not-found (exit 2); app never showed "trial-sample-app" or a read-only scan step; page says: "BLOCKED / no diagnostic errors" |
| trial-windows-39011557246 | windows-msi | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-windows-39011557246 | windows-msi | close | PASS | window X closed the app |
| trial-windows-39011557246 | windows-msi | no process after close | PASS | none running |
| trial-windows-39011557246 | windows-msi | plan: idea and recommended answers | PASS | 34 recommendations used; no blocking questions |
| trial-windows-39011557246 | windows-msi | plan: approve | PASS | Plan approved |
| trial-windows-39011557246 | windows-msi | open git folder in Tasks | PASS | Workers branch from D:\a\_temp\loop-repo-windows-msi |
| trial-windows-39011557246 | windows-msi | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-windows-39011557246 | windows-msi | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (404 chars, private key not logged) |
| trial-windows-39011557246 | windows-msi | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-bdf16655 checked in as worker on T-1; window shows "Test to approve" |
| trial-windows-39011557246 | windows-msi | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Test approved \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-bdf16655 (claude-trial) · approved by you (owner) |
| trial-windows-39011557246 | windows-msi | stand-in worker builds, commits, attaches proof | **FAIL** | claim_task: REFUSED: T-1 cannot be claimed: T-1's test has not been run on the current code yet. (RULE) Window says: Test approved [window 1008x681; visible buttons: PP Perfect Planner v0.1 clea \| Home \| 01Define \| 02Coordinate \| 03Build \| 04Prove \| 05Release \| Index \| Connect agent \| More  |
| trial-windows-39011557246 | windows-msi | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-39011557246 | windows-msi | uninstall user data | **FAIL** | left: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (13 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (209 files) |

113 of 133 checks did not fail across 4 jobs; 20 failed.
