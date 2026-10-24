## Installer trial ([run](https://github.com/affordablefencinggc/perfect-planner/actions/runs/40086989742))

| Job | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| trial-linux-rpm-40082330538 | 3 | 0 | 0 |
| trial-linux-ubuntu-22.04-40082330538 | 46 | 0 | 0 |
| trial-linux-ubuntu-24.04-40082330538 | 46 | 0 | 0 |
| trial-windows-40082330538 | 50 | 0 | 0 |

| Job | Target | Check | Result | What was seen |
| --- | --- | --- | --- | --- |
| trial-linux-rpm-40082330538 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-cbad07b-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-40082330538 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-40082330538 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libsecret-tools, libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | launch | PASS | WebDriver session up after 588 ms |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "YPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | connect agent shows a line | PASS | first line: "'/usr/lib/Perfect Planner/desktop-host/node' '/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' --agent claude http://127.0.0.1:33795 '/home/runner/.local/share/com.perfectplanner.desktop/authority/core/projects/default/.perfect-" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | close | PASS | session closed in 57 ms |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 30 ms each on average, slowest 83 ms |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-22.04-deb |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (355 chars, private key not logged) |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-0302cdeb checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-0302cdeb (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | stand-in worker builds, commits, attaches proof | PASS | proof attached at 0d759318bb12 |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | merge into main | PASS | main now holds src/notes.mjs (409cf09 Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-deb | uninstall user data | PASS | kept by design: /home/runner/.local/share/com.perfectplanner.desktop (74 files) |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-cbad07b-linux-x64.AppImage 128M |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | launch | PASS | WebDriver session up after 507 ms |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "YPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | connect agent shows a line | PASS | first line: "'/tmp/.mount_PerfecaIpIAL/usr/lib/Perfect Planner/desktop-host/node' '/tmp/.mount_PerfecaIpIAL/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' --agent claude http://127.0.0.1:37033 '/home/runner/.local/share/com.perfectplanner.d" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | close | PASS | session closed in 48 ms |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 31 ms each on average, slowest 96 ms |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-22.04-appimage |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (408 chars, private key not logged) |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-fb066491 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-fb066491 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | stand-in worker builds, commits, attaches proof | PASS | proof attached at efa5b6647adf |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | merge into main | PASS | main now holds src/notes.mjs (30df9d4 Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-22.04-40082330538 | ubuntu-22.04-appimage | uninstall user data | PASS | kept by design after deleting the AppImage: /home/runner/.local/share/com.perfectplanner.desktop (72 files) |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | package metadata | PASS | Package: perfect-planner Version: 0.1.0 Architecture: amd64 Depends: libsecret-tools, libwebkit2gtk-4.1-0, libgtk-3-0 |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | install | PASS | apt installed perfect-planner; binary /usr/bin/perfect-planner-desktop; files: /usr/bin /usr/bin/planner-agent-helper /usr/bin/perfect-planner-desktop /usr/lib /usr/lib/Perfect Planner /usr/lib/Perfect Planner/desktop-host /usr/lib/Perfect Planner/desktop-host/NODE-LICENSE.txt /usr/lib/Perfect Plann |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | desktop entry | PASS | /usr/share/applications/Perfect Planner.desktop valid; Exec=perfect-planner-desktop |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | shared libraries | PASS | ldd: all resolved |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | launch | PASS | WebDriver session up after 3763 ms |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 24 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Roster not connected Agent connection · unverified No forecast Collision check unavailable Connec" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "YPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | connect agent shows a line | PASS | first line: "'/usr/lib/Perfect Planner/desktop-host/node' '/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' --agent claude http://127.0.0.1:46541 '/home/runner/.local/share/com.perfectplanner.desktop/authority/core/projects/default/.perfect-" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | close | PASS | session closed in 8 ms |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 32 ms each on average, slowest 82 ms |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-24.04-deb |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (355 chars, private key not logged) |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-11444c25 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-11444c25 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | stand-in worker builds, commits, attaches proof | PASS | proof attached at a08a2e17c370 |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | merge into main | PASS | main now holds src/notes.mjs (0288dfa Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | uninstall program files | PASS | apt purge exit 0; nothing left |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-deb | uninstall user data | PASS | kept by design: /home/runner/.local/share/com.perfectplanner.desktop (75 files) |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | install | PASS | PerfectPlanner-dry-run-v0.1.0-cbad07b-linux-x64.AppImage 128M |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | launch | PASS | WebDriver session up after 562 ms |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | first-run screen | PASS | "Perfect Planner Starting Perfect Planner…" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rela" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "YPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | connect agent shows a line | PASS | first line: "'/tmp/.mount_PerfecMgoieb/usr/lib/Perfect Planner/desktop-host/node' '/tmp/.mount_PerfecMgoieb/usr/lib/Perfect Planner/desktop-host/core-host/connect.mjs' --agent claude http://127.0.0.1:32771 '/home/runner/.local/share/com.perfectplanner.d" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | close | PASS | session closed in 44 ms |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 32 ms each on average, slowest 96 ms |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | plan: approve | PASS | Plan approved |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | open git folder in Tasks | PASS | Workers branch from /home/runner/work/_temp/loop-repo-ubuntu-24.04-appimage |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (408 chars, private key not logged) |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-0df54013 checked in as worker on T-1; window shows "Test to approve" |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-0df54013 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | stand-in worker builds, commits, attaches proof | PASS | proof attached at 456c1a82d3a6 |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | check the work in the window | PASS | check passed |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | read the diff and approve it | PASS | diff approved |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | merge into main | PASS | main now holds src/notes.mjs (bde698f Merge pp/T-1 (T-1) into main) |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | no process after close | PASS | none running |
| trial-linux-ubuntu-24.04-40082330538 | ubuntu-24.04-appimage | uninstall user data | PASS | kept by design after deleting the AppImage: /home/runner/.local/share/com.perfectplanner.desktop (72 files) |
| trial-windows-40082330538 | windows-nsis | install | PASS | exit 0 in 8 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-40082330538 | windows-nsis | installed files | PASS | 210 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-CzJic3gk.js, BlueprintWorkspace-Ce-ZE9Et.js, BlueprintWorkspace-QcWZHFF6.css, censusPaths-Dj7CPR0i.js, Code.es-fY8Gh |
| trial-windows-40082330538 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |
| trial-windows-40082330538 | windows-nsis | launch | PASS | window up, WebView2 Edg/155.0.4283.62 after 2 s |
| trial-windows-40082330538 | windows-nsis | launch | PASS | WebDriver session up after 1042 ms |
| trial-windows-40082330538 | windows-nsis | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 24 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project fac" |
| trial-windows-40082330538 | windows-nsis | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rel" |
| trial-windows-40082330538 | windows-nsis | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "TYPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed " |
| trial-windows-40082330538 | windows-nsis | connect agent shows a line | PASS | first line: "& 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\node.exe' 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\core-host\\connect.mjs' --agent claude http://127.0.0.1:52794 'C:\\Users\\runneradmin\\AppData\\Roaming" |
| trial-windows-40082330538 | windows-nsis | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-windows-40082330538 | windows-nsis | close | PASS | window X closed the app |
| trial-windows-40082330538 | windows-nsis | no process after close | PASS | none running |
| trial-windows-40082330538 | windows-nsis | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 160 ms each on average, slowest 1128 ms |
| trial-windows-40082330538 | windows-nsis | plan: approve | PASS | Plan approved |
| trial-windows-40082330538 | windows-nsis | open git folder in Tasks | PASS | Workers branch from D:\a\_temp\loop-repo-windows-nsis |
| trial-windows-40082330538 | windows-nsis | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-windows-40082330538 | windows-nsis | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (405 chars, private key not logged) |
| trial-windows-40082330538 | windows-nsis | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-dcc21a19 checked in as worker on T-1; window shows "Test to approve" |
| trial-windows-40082330538 | windows-nsis | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-dcc21a19 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-windows-40082330538 | windows-nsis | stand-in worker builds, commits, attaches proof | PASS | proof attached at 5a682a5d5f64 |
| trial-windows-40082330538 | windows-nsis | check the work in the window | PASS | check passed |
| trial-windows-40082330538 | windows-nsis | read the diff and approve it | PASS | diff approved |
| trial-windows-40082330538 | windows-nsis | merge into main | PASS | main now holds src/notes.mjs (1ba6dee Merge pp/T-1 (T-1) into main) |
| trial-windows-40082330538 | windows-nsis | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-40082330538 | windows-nsis | uninstall user data | PASS | kept by design: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (12 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (197 files) |
| trial-windows-40082330538 | windows-msi | install | PASS | exit 0 in 6 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-40082330538 | windows-msi | installed files | PASS | 210 files: perfect-planner-desktop.exe, planner-agent-helper.exe, Uninstall Perfect Planner.lnk, desktop-host.json, NODE-LICENSE.txt, node.exe, favicon.ico, favicon.svg, index.html, ArrowClockwise.es-CzJic3gk.js, BlueprintWorkspace-Ce-ZE9Et.js, BlueprintWorkspace-QcWZHFF6.css, censusPaths-Dj7CPR0i.j |
| trial-windows-40082330538 | windows-msi | start menu shortcut | PASS | C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Perfect Planner\Perfect Planner.lnk |
| trial-windows-40082330538 | windows-msi | launch | PASS | window up, WebView2 Edg/155.0.4283.62 after 1 s |
| trial-windows-40082330538 | windows-msi | launch | PASS | WebDriver session up after 90 ms |
| trial-windows-40082330538 | windows-msi | first-run screen | PASS | "PP Perfect Planner v0.1 clean-room · Saturday 24 October 2026 Home 01Define 02Coordinate 03Build 04Prove 05Release Index / Connect agent No project selected PURPOSE Choose a local app folder without inventing project fac" |
| trial-windows-40082330538 | windows-msi | settings opens | PASS | opened via "Settings": "Settings Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never rel" |
| trial-windows-40082330538 | windows-msi | open project folder | PASS | dialog: typed the folder path (dialog-not-found); pressed Use this folder; app shows: "TYPE OR PASTE THE FOLDER PATH Use this folder Ready to scan trial-sample-app. The scan only reads files; nothing is run or moved. App discovery map Empty until a folder is indexed " |
| trial-windows-40082330538 | windows-msi | connect agent shows a line | PASS | first line: "& 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\node.exe' 'C:\\Users\\runneradmin\\AppData\\Local\\Perfect Planner\\desktop-host\\core-host\\connect.mjs' --agent claude http://127.0.0.1:57223 'C:\\Users\\runneradmin\\AppData\\Roaming" |
| trial-windows-40082330538 | windows-msi | connect lines runnable as copied | PASS | 1 copyable block(s); none has placeholders |
| trial-windows-40082330538 | windows-msi | close | PASS | window X closed the app |
| trial-windows-40082330538 | windows-msi | no process after close | PASS | none running |
| trial-windows-40082330538 | windows-msi | plan: idea and recommended answers | PASS | 25 recommendations used; no blocking questions; 25 answers saved, 168 ms each on average, slowest 1165 ms |
| trial-windows-40082330538 | windows-msi | plan: approve | PASS | Plan approved |
| trial-windows-40082330538 | windows-msi | open git folder in Tasks | PASS | Workers branch from D:\a\_temp\loop-repo-windows-msi |
| trial-windows-40082330538 | windows-msi | connect agent: line runs as copied, agent checks in | PASS | checked in as main; line on the app's own Node |
| trial-windows-40082330538 | windows-msi | start worker on T-1 (window gives the set-up command) | PASS | set-up command shown (404 chars, private key not logged) |
| trial-windows-40082330538 | windows-msi | stand-in worker checks in over MCP and proposes a test | PASS | trial-worker-ad74a5e8 checked in as worker on T-1; window shows "Test to approve" |
| trial-windows-40082330538 | windows-msi | approve test in the window (it fails first) | PASS | T-1 \| Build App shell \| Waiting for the worker to claim \| Done-when test \| node tests/notes.check.mjs \| tests/notes.check.mjs · Proposed by trial-worker-ad74a5e8 (claude-trial) · approved by you (owner) · fails on today's code |
| trial-windows-40082330538 | windows-msi | stand-in worker builds, commits, attaches proof | PASS | proof attached at 4355e808c6d5 |
| trial-windows-40082330538 | windows-msi | check the work in the window | PASS | check passed |
| trial-windows-40082330538 | windows-msi | read the diff and approve it | PASS | diff approved |
| trial-windows-40082330538 | windows-msi | merge into main | PASS | main now holds src/notes.mjs (b8130a9 Merge pp/T-1 (T-1) into main) |
| trial-windows-40082330538 | windows-msi | uninstall program files | PASS | exit 0; nothing left |
| trial-windows-40082330538 | windows-msi | uninstall user data | PASS | kept by design: C:\Users\runneradmin\AppData\Roaming\com.perfectplanner.desktop (12 files); C:\Users\runneradmin\AppData\Local\com.perfectplanner.desktop (197 files) |

145 of 145 checks did not fail across 4 jobs; 0 failed.
