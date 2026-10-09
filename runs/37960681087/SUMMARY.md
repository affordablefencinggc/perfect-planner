## Installer trial ([run](https://github.com/affordablefencinggc/perfect-planner/actions/runs/37960681087))

| Job | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| trial-linux-rpm-37918632579 | 3 | 0 | 0 |
| trial-linux-rpm-37954032842 | 3 | 0 | 0 |
| trial-macos-arm64-37954032842 | 8 | 1 | 0 |
| trial-windows-37918632579 | 3 | 0 | 0 |

| Job | Target | Check | Result | What was seen |
| --- | --- | --- | --- | --- |
| trial-linux-rpm-37918632579 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-58ff834-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-37918632579 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-37918632579 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-linux-rpm-37954032842 | fedora-rpm | install | PASS | dnf installed PerfectPlanner-dry-run-v0.1.0-6a5c0a8-linux-x64.rpm; /usr/bin/perfect-planner-desktop /usr/bin/planner-agent-helper /usr/share/applications/Perfect Planner.desktop |
| trial-linux-rpm-37954032842 | fedora-rpm | shared libraries | PASS | ldd: all resolved on Fedora 41 |
| trial-linux-rpm-37954032842 | fedora-rpm | uninstall program files | PASS | dnf remove ok; nothing left |
| trial-macos-arm64-37954032842 | macos-arm64 | dmg contents | PASS | Applications Perfect Planner.app (Applications shortcut: yes) |
| trial-macos-arm64-37954032842 | macos-arm64 | install | PASS | /Applications/Perfect Planner.app; Mach-O 64-bit executable arm64; LSMinimumSystemVersion 10.13 |
| trial-macos-arm64-37954032842 | macos-arm64 | installed files | PASS | Contents/MacOS: perfect-planner-desktop planner-agent-helper |
| trial-macos-arm64-37954032842 | macos-arm64 | code signature | PASS | verify: ok; Signature=adhoc TeamIdentifier=not set |
| trial-macos-arm64-37954032842 | macos-arm64 | gatekeeper (downloaded copy) | **FAIL** | /var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/tmp.69f0myf5i0/Perfect Planner.app: rejected (not notarized: first open needs System Settings > Privacy & Security > Open Anyway) |
| trial-macos-arm64-37954032842 | macos-arm64 | launch | PASS | pid 1508; still running after 12 s: yes |
| trial-macos-arm64-37954032842 | macos-arm64 | window shown | PASS | windows: count=1 "Perfect Planner" |
| trial-macos-arm64-37954032842 | macos-arm64 | first-run screen | PASS | Perfect Planner \| standard window group group Perfect Planner Open Perfect Planner home \| Open Perfect Planner home Build stages \| Build stages Home Define \| Define Coordinate \| Coordinate Build \| Build Prove \| Prove Rel |
| trial-macos-arm64-37954032842 | macos-arm64 | settings opens | PASS | pressed /^settings$/i (first of 1) |
| trial-windows-37918632579 | windows-nsis | install | PASS | exit 0 in 2 s; C:\Users\runneradmin\AppData\Local\Perfect Planner\perfect-planner-desktop.exe; uninstall entry: True |
| trial-windows-37918632579 | windows-nsis | installed files | PASS | 3 files: perfect-planner-desktop.exe, planner-agent-helper.exe, uninstall.exe; agent helper sidecar: planner-agent-helper.exe |
| trial-windows-37918632579 | windows-nsis | start menu shortcut | PASS | C:\Users\runneradmin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Perfect Planner.lnk |

17 of 18 checks did not fail across 4 jobs; 1 failed.
