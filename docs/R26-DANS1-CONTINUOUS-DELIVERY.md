# R26 DANS1 stage handover

## Purpose

`scripts/stage-r26-dans1.mjs` creates a side-by-side Perfect Planner desktop stage on DANS1 from the already verified R26 checkout. It checks the exact qualification and approval receipts, confirms the checkout is clean and that product files still match the qualified release revision, performs a fresh Tauri no-bundle build in an isolated target directory, copies the executable and its generated `desktop-host` resources, and records SHA-256 hashes. It runs with DANS1's installed Node runtime and does not change PowerShell execution policy.

This is a **staging** step. It does not create or install an MSI/NSIS installer, launch the app, change login or database behavior, or deploy to production. The task and UI trial remain separate work.

## Pinned DANS1 inputs

- Checkout: `C:\Users\danie\projects\Planner-Release-20261110-r26`
- Branch and checkout HEAD: `codex/qualification-r26` at `cfa409d6e8e33213ef740e833d0f7941d09c5e2e`
- Release proof revision: `3e1164a55d10b2d8ef4a5884d197d64da59aeb0d`
- Release tree digest: `677df5213d90a28c129795c5a9b0ba803570c47d85076aca2c04a937358e3bdf`
- Ledger at the time of handover: 5/5 items verified; the exact `ledger.mjs check` receipt remains authoritative.
- Default isolated stage: `C:\Users\danie\Documents\PerfectPlannerEvidence\20261120-R26-DANS1-Stage-03`

The checkout is one ledger-record commit ahead of the qualified release commit. The script allows only that exact state and rejects any product/source diff outside `LEDGER.json`, `LEDGER.md`, and `.ledger/logs/**`.

## Run

Copy the script to a new, empty folder under `C:\Users\danie\Documents\PerfectPlannerEvidence`, then on DANS1 first review its plan:

The completed Stage-03 folder already exists; do not rerun the default command or overwrite it. For a new build, copy the helper into a new empty StagePrep folder and choose another unused output folder (the example below uses Stage-04). The current dependency snapshot is at `C:\Users\danie\Documents\PerfectPlannerEvidence\20261120-R26-StagePrep\r26-node-modules.tar.gz` with SHA-256 `2445ce288149ac212320898d1ed987b60c3fe22eb4231829e506b921574fef25`. Pass its SHA-256 to both commands so the script verifies the exact copied dependency set:

```powershell
node .\stage-r26-dans1-v3.mjs --plan-only --dependencies-sha256 2445ce288149ac212320898d1ed987b60c3fe22eb4231829e506b921574fef25 --stage-root C:\Users\danie\Documents\PerfectPlannerEvidence\20261120-R26-DANS1-Stage-04
node .\stage-r26-dans1-v3.mjs --dependencies-sha256 2445ce288149ac212320898d1ed987b60c3fe22eb4231829e506b921574fef25 --stage-root C:\Users\danie\Documents\PerfectPlannerEvidence\20261120-R26-DANS1-Stage-04
```

If the printed host, branch, heads, digests and output path match this handover, run it without `--plan-only`. Do not reuse or overwrite a prior stage directory; choose a new `--stage-root` for a retry. The script requires at least 6 GiB free and refuses to run off DANS1, on a dirty checkout, on a different revision, or if evidence does not match the pinned values.

## Output layout

The stage root contains:

- `app\perfect-planner-desktop.exe`
- `app\desktop-host\...` (the runtime resources expected beside the executable)
- `proof\release-evidence.json` and `proof\release-approval.json`
- `proof\tauri-no-bundle-build.log`
- `stage-manifest.json` with source revision, release receipt binding, executable/resource hashes and build runtime versions
- `stage-r26-dans1.mjs`
- `cargo-target\...` retained so the build can be inspected without deleting its provenance

The app is not considered live or UI-verified until the exact staged executable is launched and its UI state is checked. A real task run also requires a correctly scoped project and actual worker activity; neither is synthesized by this script.

## Current handover state

At the start of the 2026-11-20 continuation, the five release-ledger items were verified and a Planner desktop process was already running on DANS1. A preliminary PowerShell launcher had been refused by DANS1 execution policy; no execution policy setting was changed. The connected Remote Desktop Commander device reported host `Daniels`, not `dans1`, so it is not used for control or screenshots.

The first Node staging attempt ran the fresh Tauri build successfully in `20261120-R26-DANS1-Stage-02` (release profile finished in 2m05s; 17 Rust warnings, no compiler errors), then stopped before writing its stage manifest because Node 24 rejected direct `spawnSync("npm.cmd")` with `EINVAL`. The executable, resources and build log from that attempt remain in the Stage-02 folder as incomplete evidence; it was not overwritten. The helper now runs the npm version probe through `cmd.exe`.

The local dependency snapshot was hash-checked and transferred over strict-host-key SSH/SCP to the task-specific StagePrep folder. The remote archive hash matches the local SHA-256 above. The corrected script's read-only DANS1 preflight passed against the pinned branch, checkout, release receipts, approval and archive. The fresh Stage-03 no-bundle release build completed successfully in 2m14s, with 17 Rust warnings and no compiler errors. Its manifest records the exact qualified revision, build command, dependency hash, executable and resources. Stage-03 contains 211 generated `desktop-host` files. Executable SHA-256: `6bc85d98435990a43f7b14c968abbe8b26ee2f0615ad601776fc46609ac91863`. Manifest SHA-256: `d2cb56d0e55fc40f570ed80d87a2da17eacb4aec3403519801566d4dd6317af0`. The original checkout remains clean at `cfa409d6e8e33213ef740e833d0f7941d09c5e2e`; its broken `node_modules` junction still targets the 2026-11-09 checkout and was not changed.

The app was deliberately not launched. The available Remote Desktop Commander device identified itself as `Daniels`, not DANS1, and therefore is not used to control or capture the DANS1 desktop. The currently running DANS1 Planner process has the earlier executable hash `80062CD3FA2C9494A663D1BEE3E3F3E765F7BE3880C506ED375D7ABC7151B40C`, so it is not evidence for the staged build. The real Finish-Lines task and UI proof remain open until a DANS1-identified desktop session and a correctly scoped test project/worker are available; native folder-picker consent and IDE pairing must come from the actual user and cannot be simulated.
