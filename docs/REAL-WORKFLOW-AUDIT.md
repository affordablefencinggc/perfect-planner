# Real workflow audit

Audited against the running local app at `http://127.0.0.1:4173` on 4 September 2026. This is an interaction audit, not a screenshot review.

## Current verdict

The interface routes, but the product is not yet an end-to-end operational planner. Repository intake is now usable through a secure browser folder picker or the Tauri picker, but the imported census is not yet the single source driving Coordinate, Build, Prove, and Release. Those later workspaces still render the bundled PP-014 sample plan.

## Live route and control evidence

| Surface | Exercised action | Actual result | Status |
| --- | --- | --- | --- |
| Project Home | Clicked **Drop your app** | Opened Structure | Works |
| Blueprint | Clicked **Define** | Opened `workspace=blueprint` | Works |
| Structure | Pasted `C:\repos\perfect-planner-cleanroom` in the old browser field and approved | Browser rejected it only after approval because arbitrary pasted paths have no browser authority | Fixed: browser now uses a secure directory picker and the approval button remains disabled until a real handle exists |
| Plan | Clicked **Coordinate** | Opened `workspace=plan` | Works, sample data |
| Collisions | Clicked **Collisions** | Opened collision census; durable authority returned 403 | Blocked: sample manifests, authority unavailable |
| Allocation | Clicked **Allocation** | Schedule rendered; branch/worktree creation is disabled | Blocked: no authoritative collision clearance or live Git adapter |
| Build | Clicked **Build** | Conveyor rendered at entry gate | Blocked by the unresolved sample collision |
| Integrity | Clicked **Prove** | NO-GO rendered | Works as a sample verdict; not bound to the newly imported repository |
| Evidence | Opened J02 | Card expanded and inspector displayed files, people, and proof gaps | Works as sample evidence |
| Release/Ledger | Clicked **Release** | Ledger rendered | Works as sample ledger; an Evidence inspector incorrectly remained open |
| Index | Clicked **Index** | Searchable project index rendered | Works as sample index; stale inspector also remained open |
| Operations | Opened Logs, Errors, and MCP events | Tabs worked, but the log began with invented historical events and the earlier intake failure was missing | Fixed: seeded fictional events removed; intake failures now enter Errors |

## Defects fixed during this audit

- Added a real browser directory-handle adapter. It enumerates the user-selected folder only after a second approval, applies file-count and file-size bounds, hashes files, returns metadata without file contents, and refuses pasted identities.
- Kept the existing Tauri folder picker and registered census path; all six native tests pass.
- Closed repository and inspector drawers whenever the primary workspace changes.
- Routed Structure intake failures to the shared diagnostics console.
- Removed fictional startup log events.
- Registered the browser census implementation and its tests in the fail-closed application atlas.

## Remaining blocking product work

1. Replace the bundled PP-014 sample state after intake with one project state derived from the imported census.
2. Start the local collision authority with the app and prove a non-403 session before enabling decisions.
3. Connect collision clearance to real branch/worktree creation and surface every Git refusal in Operations.
4. Derive Build, Integrity, Evidence, Ledger, and Index from the same imported project identity and census digest.
5. Replace hard-coded counts such as source totals, test totals, progress, people, and files with generated or explicitly labelled sample values.
6. Record MCP connection attempts, permission changes, tool calls, and failures in MCP events.
7. Add a real browser-driven regression suite that imports a fixture directory, traverses every workspace, opens every global menu, and verifies state continuity.

## Verification run

- Engine/integration suite: 394 passed.
- UI suite: 18 passed.
- Native Rust suite: 6 passed.
- Sites worker/package suite: 4 passed.
- Production build: passed.
- Build warning: one JavaScript chunk remains above 500 kB and needs code splitting.
- Generated truth remains correctly blocked: merged-state CI is grey, remote CI is unconfigured, human confirmation is absent, viability inputs are incomplete, and reviewer quorum is incomplete.
