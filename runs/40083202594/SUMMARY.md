## Installer trial ([run](https://github.com/affordablefencinggc/perfect-planner/actions/runs/40083202594))

| Job | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| trial-linux-rpm-40082562461 | 3 | 0 | 0 |
| trial-linux-ubuntu-22.04-40082562461 | 42 | 2 | 0 |
| trial-linux-ubuntu-24.04-40082562461 | 42 | 2 | 0 |
| trial-windows-40082562461 | 46 | 2 | 0 |

| Job | Target | Check | Result | What was seen |
| --- | --- | --- | --- | --- |
| trial-linux-rpm-40082562461 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-c4bc42a-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-40082562461 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-40082562461 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libsecret-tools, libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 263 ms |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "YPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | close | PASS | session closed in 44 ms |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 19 ms each on average, slowest 54 ms |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-22.04-deb |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (355 chars, private key not logged) |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-09576860 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-09576860 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | stand-in worker builds, commits, attaches proof | PASS | proof attached at 35e59a385ad5 |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | merge into main | PASS | main now holds src/notes.mjs (a31aacf Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-deb | uninstall user data | PASS | kept by design: /home/runner/.local/share/com.perfectplanner.desktop (74 files) |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-c4bc42a-linux-x64.AppImage 128M |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 304 ms |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | settings opens | PASS | opened via "SettingsFine-tune every stage, feature and agent default": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "YPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | close | PASS | session closed in 44 ms |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 19 ms each on average, slowest 54 ms |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-22.04-appimage |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (408 chars, private key not logged) |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-8967e861 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-8967e861 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | stand-in worker builds, commits, attaches proof | PASS | proof attached at e47f29800e3e |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | merge into main | PASS | main now holds src/notes.mjs (5af4fe3 Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-40082562461 | ubuntu-22.04-appimage | uninstall user data | PASS | kept by design after deleting the AppImage: /home/runner/.local/share/com.perfectplanner.desktop (72 files) |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libsecret-tools, libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 1581 ms |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 24 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Roster not connected Agent connection · unverified No forecast Collision check unavailable Connec" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "YPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | close | PASS | session closed in 3 ms |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 19 ms each on average, slowest 58 ms |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-24.04-deb |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (355 chars, private key not logged) |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-711c9f0c checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-711c9f0c (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | stand-in worker builds, commits, attaches proof | PASS | proof attached at d511eb2927af |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | merge into main | PASS | main now holds src/notes.mjs (87c0205 Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-deb | uninstall user data | PASS | kept by design: /home/runner/.local/share/com.perfectplanner.desktop (73 files) |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-c4bc42a-linux-x64.AppImage 128M |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 343 ms |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "YPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | close | PASS | session closed in 44 ms |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 20 ms each on average, slowest 61 ms |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-24.04-appimage |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (408 chars, private key not logged) |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-007dc430 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-007dc430 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | stand-in worker builds, commits, attaches proof | PASS | proof attached at f3550e1e760b |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | merge into main | PASS | main now holds src/notes.mjs (6c58ec0 Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-40082562461 | ubuntu-24.04-appimage | uninstall user data | PASS | kept by design after deleting the AppImage: /home/runner/.local/share/com.perfectplanner.desktop (74 files) |
| trial-windows-40082562461 | windows-nsis | install | PASS | exit 0 in 7 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-40082562461 | windows-nsis | installed files | PASS | 210 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-CzJic3gk.js, BlueprintWorkspace-Ce-ZE9Et.js, BlueprintWorkspace-QcWZHFF6.css, censusPaths-Dj7CPR0i.js, Code.es-fY8Gh |
| trial-windows-40082562461 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |
| trial-windows-40082562461 | windows-nsis | launch | PASS | window up, WebView2 Edg/155.0.4283.62 after 3 s |
| trial-windows-40082562461 | windows-nsis | launch | PASS | WebDriver session up after 1410 ms |
| trial-windows-40082562461 | windows-nsis | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 24 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project fac" |
| trial-windows-40082562461 | windows-nsis | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rel" |
| trial-windows-40082562461 | windows-nsis | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "TYPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed " |
| trial-windows-40082562461 | windows-nsis | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-windows-40082562461 | windows-nsis | close | PASS | window X closed the app |
| trial-windows-40082562461 | windows-nsis | no process after close | PASS | none running |
| trial-windows-40082562461 | windows-nsis | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 164 ms each on average, slowest 1223 ms |
| trial-windows-40082562461 | windows-nsis | plan: approve | PASS | Plan approved |
| trial-windows-40082562461 | windows-nsis | open git folder in Tasks | PASS | Workers branch from D:\a\_temp\loop-repo-windows-nsis |
| trial-windows-40082562461 | windows-nsis | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-windows-40082562461 | windows-nsis | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (405 chars, private key not logged) |
| trial-windows-40082562461 | windows-nsis | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-d7fe97bc checked in as worker on T-1; window shows "Test to approve" |
| trial-windows-40082562461 | windows-nsis | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-d7fe97bc (claude-trial) · approved by you (owner) · fails on today's code |
| trial-windows-40082562461 | windows-nsis | stand-in worker builds, commits, attaches proof | PASS | proof attached at 977855d1e72c |
| trial-windows-40082562461 | windows-nsis | check the work in the window | PASS | check passed |
| trial-windows-40082562461 | windows-nsis | read the diff and approve it | PASS | diff approved |
| trial-windows-40082562461 | windows-nsis | merge into main | PASS | main now holds src/notes.mjs (f3e4270 Merge pp/T-1 (T-1) into main) |
| trial-windows-40082562461 | windows-nsis | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-40082562461 | windows-nsis | uninstall user data | PASS | kept by design: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (12 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (197 files) |
| trial-windows-40082562461 | windows-msi | install | PASS | exit 0 in 7 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-40082562461 | windows-msi | installed files | PASS | 210 files: perfect-planner-desktop.exe, planner-agent-helper.exe, Uninstall Perfect Planner.lnk, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-CzJic3gk.js, BlueprintWorkspace-Ce-ZE9Et.js, BlueprintWorkspace-QcWZHFF6.css, censusPaths-Dj7CPR0i.j |
| trial-windows-40082562461 | windows-msi | start menu shortcut | PASS | C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Perfect Planner\Perfect Planner.lnk |
| trial-windows-40082562461 | windows-msi | launch | PASS | window up, WebView2 Edg/155.0.4283.62 after 1 s |
| trial-windows-40082562461 | windows-msi | launch | PASS | WebDriver session up after 84 ms |
| trial-windows-40082562461 | windows-msi | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 24 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project fac" |
| trial-windows-40082562461 | windows-msi | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rel" |
| trial-windows-40082562461 | windows-msi | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "TYPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed " |
| trial-windows-40082562461 | windows-msi | connect agent shows a line | **FAIL** | no line; panel says "AGENT CHECK-IN Connect agent Connect an agent Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks. This folder has no Perfect Planner hist" |
| trial-windows-40082562461 | windows-msi | close | PASS | window X closed the app |
| trial-windows-40082562461 | windows-msi | no process after close | PASS | none running |
| trial-windows-40082562461 | windows-msi | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 177 ms each on average, slowest 1236 ms |
| trial-windows-40082562461 | windows-msi | plan: approve | PASS | Plan approved |
| trial-windows-40082562461 | windows-msi | open git folder in Tasks | PASS | Workers branch from D:\a\_temp\loop-repo-windows-msi |
| trial-windows-40082562461 | windows-msi | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-windows-40082562461 | windows-msi | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (404 chars, private key not logged) |
| trial-windows-40082562461 | windows-msi | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-0f03cb2a checked in as worker on T-1; window shows "Test to approve" |
| trial-windows-40082562461 | windows-msi | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-0f03cb2a (claude-trial) · approved by you (owner) · fails on today's code |
| trial-windows-40082562461 | windows-msi | stand-in worker builds, commits, attaches proof | PASS | proof attached at 96e5cbc8fbd6 |
| trial-windows-40082562461 | windows-msi | check the work in the window | PASS | check passed |
| trial-windows-40082562461 | windows-msi | read the diff and approve it | PASS | diff approved |
| trial-windows-40082562461 | windows-msi | merge into main | PASS | main now holds src/notes.mjs (62633b6 Merge pp/T-1 (T-1) into main) |
| trial-windows-40082562461 | windows-msi | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-40082562461 | windows-msi | uninstall user data | PASS | kept by design: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (12 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (197 files) |

133 of 139 checks did not fail across 4 jobs; 6 failed.
