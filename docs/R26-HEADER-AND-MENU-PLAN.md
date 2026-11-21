# R26 header and menu re-organisation plan

**Status: P1 (remove from list and the Settings/Add-project overlap fix) plus a first slice of the header changes (a collapsible context strip, capped project tabs, restore to the old position; section 13a) are implemented in the carryover working tree, proven in a scratch build on DANS1 and on a localhost build in the browser. They are committed locally, not pushed, and not on the qualified DANS1 checkout. P0 and P2-P6 are not started, and the stylesheet budget (section 10) blocks landing them without an owner decision.** Written 2026-11-21 by Claude (Sonnet 5.5) at the owner's request: "the grey creamy header at the top should be a drop down", "the menu layout up top", "the menu layout left side", "make a bullet proof plan", plus "there's no way to close working folders or remove them, just a long pile of folders".

Scope: desktop only (owner decision 2026-11-11, reconfirmed 2026-11-21). Phone and tablet layouts are not a target and are not checked.

---

## 1. Goal, in one sentence

A first-time user can add a folder, always see which project is open, remove a folder from the list in two clicks without fear, find Settings in one click, and never see a button covered by another one.

**Non-goals:** no change to the five-stage journey, the ledger, the proof rules, or what the app claims. No phone/tablet work. No deletion of anything on disk.

## 2. Rules from `AGENTS.md` that the redesign must keep

| Rule | What it means here |
|---|---|
| Journey is Project Home, then Define, Coordinate, Build, Prove, Release | The five numbered stage buttons stay in the top bar, in this order. |
| A selected stage reveals only its own sub-pages | Sub-pages (Blueprint, Structure, ...) stay visible and stay stage-scoped. |
| Index is a separate overlay, available everywhere, not a stage | Index stays a top-bar action, not a numbered stage. |
| Every workspace carries a compact "you are here" context: purpose, required outcome, what unlocks the next stage | The strip becomes collapsible, but the three facts must stay one click away on every workspace and visible by default on a project's first visit to a page. |
| Left repository rail and right inspector are concealed edge drawers by default | The left panel stays a concealed edge drawer. |
| Operations dock is collapsed by default | Unchanged. |
| Simple view by default, Advanced opt-in, same state and safety rules | The Simple/Advanced switch stays visible. Organisation-management items move to Advanced. |
| Green only for verified success, amber for risk, red for a hard stop | The red Settings pill is removed. The status summary uses green only when everything is verified. |
| Do not hide failures, use fake progress, or label configuration as success | Merging the status chips into one summary must still show every individual state in one click. |
| Never auto-discard user work; preserve first | "Remove" is a soft remove (section 5). Nothing on disk or in the host ledger is touched. |
| Warm beige, white, chromium-silver, charcoal, monospaced, soft bevel | Same tokens, same bezels. No new palette. |

## 3. What is wrong today (evidence)

Observed in a clean-profile walk of the real web client on DANS1 (1600x1000, 5 folders added), 2026-11-21. Screenshots are named below; they were taken in `...\20261121-R26-BeginnerWalk\shots\`.

| # | Finding | Evidence |
|---|---|---|
| F1 | **No way to close or remove a folder anywhere**: not on drawer cards, not on the tabs, not in the ellipsis menu, not in Settings (Your data has no buttons; its only advice is "uninstall the app, then delete the data folder, which also deletes the signed ledger"). | shots 06, 09, 10; walk text of Settings Your data and Reset |
| F1a | The capability already exists but nothing calls it: `closeProject()` in `src/project/ProjectProvider.jsx:251` wraps `registry.remove()` at `src/project/projectRegistry.js:490`. | `git grep closeProject` finds only the definition |
| F2 | **The same list appears three times** (edge drawer, top tab row, folder+ menu) under **five names**: "Repositories", "Project registry / Registered local projects", "Project folders", "Open projects", "Add project". | shots 01, 06, 09; `PerfectPlannerShell.jsx:1415-1423, 2738-2757, 2811` |
| F3 | **The red Settings pill covers the drawer's "Add project" button.** `.settings-launcher` is `position: fixed; left: 16px; bottom: 56px; z-index: 60` (`src/settings/settings.css:320-325`); `.side-drawer` is `z-index: 50` and its footer sits in that corner (`src/styles.css:2959-2965`). Measured: `elementFromPoint` at the button's centre returns the Settings pill; clicking "Add project" opened Settings. | shot 06, 07; measurement at 1600x1000 |
| F4 | The "Developer notes" pill sits over the "Open Deep planning" button on Build. | shot 15 (seen, not yet measured) |
| F5 | **Three stacked chrome bands** (dark bar, dark status row, cream context strip) use about 190-240 px of a 1000 px window. | shots 01, 09, 15 |
| F6 | Five status chips on a brand-new install all read as problems; "Connect agent" is styled like a status chip, not a button. | shot 01 |
| F7 | The cream strip does five jobs at once (project tabs, purpose, required outcome, unlock next, sub-page tabs plus breadcrumb plus Simple/Advanced) and truncates its own text as tabs are added (seen at 5 projects). | shot 09 |
| F8 | After the first project exists, "Define" opens Blueprint, which has no "Choose app folder". The add-folder entry is in the folder+ menu ("Add another project folder") and on Structure only. | walk step "click Define" |
| F11 | Red is used for non-danger: the Settings pill, and a "BLOCKED, 3 blockers" box on a folder that has not been scanned yet. | shots 01, 02 |
| F12 | Every project row shows the raw state word "generated". | shots 06, 09; `PerfectPlannerShell.jsx:1445-1476` |
| F13 | The ellipsis menu offers "Invite to organization" and "Organization settings" to a solo beginner and lists Settings a second time. | shot 10 |

Adjacent findings that are real but belong to other work and are only listed (section 10): the choose-folder confirmation is below the fold, the Connect agent panel has no agent picker and fails with HTTP 409 before history exists, and the page auto-scrolls after a scan.

## 4. Target design (proposal; wireframes are not final art)

### 4.1 One vocabulary

| Today | Becomes |
|---|---|
| Repositories / Project registry / Registered local projects / Project folders / Open projects | **Projects** (the list) |
| Add project / Choose app folder / Add another project folder | **Add project folder** (the action) |
| (none) | **Remove from list** (the new action; never "Delete") |
| "generated" / "stale" / "unavailable" raw states | Plain words: "Scanned", "Needs re-scan", "Folder not found", "Not scanned yet" (mapping table in `projectStatusWords.js`, advanced view still shows the raw state) |

### 4.2 Top bar: one dark row

```
[PP] Perfect Planner | Home  1 Define  2 Coordinate  3 Build  4 Prove  5 Release | Index  / Find... ......  Status: 3 need attention v | [Connect agent] | gear | ...
```

- Version and date text moves to Settings > About.
- Settings becomes a gear icon button at the right end of the bar (not a floating red pill). The ellipsis menu keeps the remaining actions; "Invite to organization" and "Organization settings" show only in Advanced view; Settings is not listed twice.
- "Connect agent" is the only filled button in the bar.

### 4.3 Status summary (replaces the four chips)

One chip, "Status: N need attention v". Its colour is the worst state: green only when everything is verified, amber for anything unverified or not connected, red only for a hard stop. Opening it shows all four rows with one plain sentence and one action each, using the existing states unchanged:

```
Roster              Not connected      Who is working on what. [Connect agent]
Agent connection    Unverified         No agent has checked in yet. [Connect agent]
Forecast            None               Needs an approved plan.
Collision check     Not run            Checks that two tasks do not edit the same file.
```

Nothing is hidden: the chip's accessible name lists the count and the worst state, and every row is reachable from the keyboard.

### 4.4 Context strip as a dropdown (the grey/cream header)

Collapsed (default after a page has been visited once; about 44 px):

```
[folder] shop-site v   Define > Structure | Blueprint  Structure  Components  Deep planning  MVP board     Why this page? v   [Simple|Advanced]
```

Expanded (one click on "Why this page?", or by default on the first visit to each workspace):

```
Purpose            Choose a local app folder without inventing project facts.
Required outcome   One stable project identity and a redacted census receipt.
Unlocks next       Add a project folder or open the clearly labelled Demo.        [Keep open] [x]
```

The three facts are exactly today's strings, so the "you are here" contract is unchanged. The open/closed choice is remembered per workspace in the existing settings store.

### 4.5 Project switcher (replaces the tab row and the folder+ menu)

One control, "[folder] shop-site v", listing every project:

```
shop-site            Scanned          ...   (row menu: Open, Re-scan, Remove from list)
recipe-app           Scanned          ...
finish-lines-copy    Needs re-scan    ...
-----------------------------------------------
+ Add project folder
Manage projects...      (opens the left panel)
```

With more than 6 projects a search box appears. The tab row is removed, which also removes the width squeeze (F7).

### 4.6 Left panel (concealed edge drawer, now the single place to manage the list)

```
Projects (5)                                      <
[ search, shown above 6 projects ]
folder  shop-site            Scanned      ...
folder  recipe-app           Scanned      ...
...
Recently removed (2)  v      [Restore] [Forget permanently]
---------------------------------------------------------
[ + Add project folder ]            (sticky footer, never covered)
```

The edge handle is renamed "Projects". The footer is padded by the layer contract (4.7), so nothing can sit on top of it.

### 4.7 Layer contract (the fix for the whole class of F3/F4)

| Layer | z-index | Notes |
|---|---|---|
| Page content | 0 | |
| Edge handles | 24 | unchanged |
| Operations dock | 40 | unchanged position |
| Side drawers | 50 | footer padded so no fixed element overlaps it |
| Popovers and menus (status, project switcher, ellipsis, context dropdown) | 80 | one shared token `--z-popover` |
| Toasts (including Undo) | 90 | `--z-toast` |
| Floating pills | **none** | The Settings pill is removed and the Developer notes pill moves into the right edge drawer handle, so nothing floats over content or drawers. |

### 4.8 Where every control goes (nothing is lost)

| Today | New home |
|---|---|
| Logo, name | Top bar, left |
| "v0.1 clean-room, date" | Settings > About |
| Home, five stages, Index, search | Top bar, centre |
| Roster / Agent / Forecast / Collision chips | Status dropdown |
| Connect agent | Top bar, filled button |
| Ellipsis menu (Runtime, MCP, Diagnostics, Export) | Top bar, ellipsis (organisation items in Advanced only) |
| Settings red pill | Top bar gear icon |
| Developer notes pill | Right edge drawer handle |
| Folder+ button and folder menu | Project switcher (4.5) |
| Project tab row | Project switcher (4.5) |
| Purpose / Required outcome / Unlock next | Context dropdown (4.4) |
| Sub-page tabs and breadcrumb | Strip, collapsed line (4.4) |
| Simple / Advanced | Strip, right end |
| Repositories edge handle and drawer | Projects edge handle and panel (4.6) |
| Add project (drawer footer) | Panel sticky footer and switcher entry |

## 5. "Remove from list" (preserve-first spec)

1. **What it does.** Removes the project from the list on this device only. The folder on disk is not read, written or deleted. Anything the host ledger holds for the project is not touched.
2. **Confirm text (exact intent):** "Remove shop-site from Perfect Planner's list? Your folder is not changed. Plans and proof saved for it stay on this computer, and you can add the folder again later."
3. **Soft remove.** The full project session is copied to a separate key, `perfect-planner.removed-projects.v1`, before it leaves the registry, so **no registry schema change is needed** (the registry validates its keys strictly, so a schema bump would be a risk). A toast offers **Undo** for 10 seconds; afterwards the project stays under "Recently removed" with **Restore** and **Forget permanently**. Nothing is purged automatically.
4. **Re-adding the same folder** gives the same project id (`createImportedProjectId`, `src/project/projectIds.js:43`, derived from the folder's identity), so drafts and approvals saved in browser storage for that id reconnect. To be confirmed by the C-01 test, not assumed.
5. **Active project.** Removing the open project switches to the next remaining one, or to Home if none, and rewrites the URL and history so Back never lands on a removed id.
6. **Unfinished work.** Intended: if the host reports tasks in progress or claimed for the project, removal is refused with the reason and the exact next action, matching the `REPO_BUSY` rule in `core/host/routes/repos.ts:73-90`. **P1 downgrade, stated plainly:** the host summary (`core/host/routes/summary.ts`) carries only the checked-in agent count and the plan's task total, not tasks in progress, so the client cannot refuse honestly. P1 shows a warning in the confirm ("N agents are checked in to this project. Removing it from the list does not stop them.") and does not block. The refusal needs a host field first (backlog B-1).
7. **Failure.** If storage refuses the write, nothing is removed and the user is told why; a corrupt "removed" shelf is ignored with a notice and never blocks the app.
8. **Two windows.** The registry already synchronises across tabs through the `storage` event; the removal must use the same path (`rebaseBeforeMutation`) so it cannot resurrect a removed project.

## 6. Delivery phases and change numbers

Every change keeps its own number and must stay accounted for (`AGENTS.md` change accounting). Phases P2-P4 are built behind one setting, `layout: "classic" | "new"` (default `classic` until the owner accepts the new layout in P6), so they can land without disturbing the existing 995 UI tests and can be switched off instantly.

| Phase | Changes | Files (anchors) | Done when |
|---|---|---|---|
| **P0 Baseline and guard** | C-00 `scripts/ui-layout-audit.mjs` (overlap, overflow and truncation audit over a real browser) and `scripts/ui-beginner-walk.mjs` (replay of the 2026-11-21 walk with assertions). Run both on the current build and record today's violations as the baseline. | new scripts; no product change | Baseline report lists F3 (and F4 if confirmed) as failures; script runs on DANS1 in a browser the run owns. |
| **P1 Remove from list + interim fix** (not behind the flag) | C-01 `removedProjects.js` store (soft remove, restore, forget). C-02 "Remove from list" on drawer rows and in the folder menu using `closeProject`, with confirm and Undo toast. C-03 interim overlap fix: while the left drawer is open, offset the Settings launcher past it (`settings.css:320-346`). | `ProjectProvider.jsx:251`, `PerfectPlannerShell.jsx:1403-1500`, `:2732-2810`, `settings.css`, `styles.css:2959` | Unit tests for the store; UI tests for confirm, Undo, restore, active-project switch and busy refusal; audit shows F3 gone; removing a folder in the running app leaves the fixture folder byte-identical. |
| **P2 Left Projects panel** | C-04 single Projects panel (rename, plain status words, per-row menu, search above 6, "Recently removed", sticky footer). C-05 layer contract tokens (`--z-popover`, `--z-toast`) and drawer footer padding. C-06 Developer notes moved into the right edge drawer handle. | `PerfectPlannerShell.jsx:1403-1530, 1839`, `styles.css:2922-3000`, `DeveloperNotes` | Audit: zero covered controls with the drawer open or closed and the ops dock open or closed. |
| **P3 Top bar** | C-07 one-row bar; version/date to About. C-08 Status dropdown (section 4.3) with unchanged underlying states. C-09 Settings gear in the bar, ellipsis trimmed, organisation items Advanced-only. | `PerfectPlannerShell.jsx:479-1340`, `styles.css:86-260, 6616-6800`, `settings/SettingsWorkspace.jsx:53` | Every state previously readable from a chip is readable in the dropdown; keyboard-only run passes. |
| **P4 Context strip dropdown + switcher** | C-10 collapsible strip (4.4) with per-workspace memory. C-11 project switcher replacing the tab row and folder menu (4.5). C-12 `layout` setting and the Settings > Display control. | `PerfectPlannerShell.jsx:2664-2900`, `styles.css:766, 5933-6140`, `settings/appSettings.js:31` | The three "you are here" strings are present on all workspaces; no truncation of primary actions at 1280 px width. |
| **P5 Copy and naming** | C-13 one vocabulary (4.1) applied to every label, aria-label and test. | all of the above | `git grep` finds none of the retired names in user-visible text. |
| **P6 Qualification and owner review** | C-14 one batched SHIP cycle, then owner review of screenshots at 1280, 1440, 1600 and 1920 px, then flip `layout` default to `new`. | ledger | Section 8. |

## 7. Verification gates (all must pass; a build or a unit test alone is not acceptance)

| Gate | What | Where |
|---|---|---|
| G1 | Unit and component tests for every change, including the failing-first case. Updated tests for the files in section 9. | local, one file at a time; full UI suite on DANS1 |
| G2 | **Overlap audit**: for every workspace, at widths 1280, 1440, 1600 and 1920, with drawers and the ops dock open and closed and each popover open, every visible interactive element's centre must hit itself or a descendant. Also: no horizontal page overflow, no truncated primary action. Any failure blocks the phase. This gate would have caught F3 and F4. | real browser on DANS1 (own profile, own port; never port 9333) |
| G3 | **Beginner walk replay**: first run, add 5 folders, remove 2, undo 1, re-add 1, open Connect agent, visit each stage, open Settings; assertions per step plus screenshots. | same |
| G4 | Keyboard and accessibility: Tab order, Escape closes every popover and returns focus, names and roles present, high-contrast theme, Larger text size, reduce-motion on. | same |
| G5 | **Data safety**: before/after file listing and hashes of the sample project folders (must be identical), host authority folder unchanged, removed session fully present in the shelf, restore returns the identical session. | same |
| G6 | Regression: full `test:ui`, `typecheck:core`, `test:core`, `verify:release` through the ledger. | DANS1 |
| G7 | Independent review by a separate agent (not the author), then the owner's own look at screenshots. The owner decides look and feel; agents do not self-approve it. | |

Evidence labelling: web-route runs are labelled web-route and never described as native-app proof. Native proof still needs the staged executable, the owner's folder consent and IDE pairing.

## 8. Qualification and ledger plan

1. **First finish what is pending:** the owner approves digest `6b04a3a9` for revision `85f15c0`, then an independent reviewer verifies `SHIP`. That gives a qualified baseline to compare against. The qualified DANS1 checkout is not touched before then.
2. Work happens on a local branch off the carryover branch; nothing is pushed beyond the feature branch named in the handover, and source commits are not pushed until their DANS1 proof exists.
3. One ledger item per phase (`UI-P1` ... `UI-P5`), each with an acceptance command (the phase's Vitest files plus the audit script), `paths` limited to the files it changes, and an independent verifier who is not the author. Items other than `SHIP` keep their proof because their `paths` do not overlap.
4. **One** batched `SHIP` cycle at the end (about 28 minutes per run), with the owner approvals that follow: approve after `test:core` is green, run, `done`, approve again, independent `verify`, then commit the ledger files last. This keeps the owner's approvals to two for the whole redesign.
5. A fresh stage root (Stage-04) is built from the final revision; Stage-03 does not contain any of this.

## 9. Existing tests that depend on what moves

Counted by `git grep` on 2026-11-21 (files, not cases): project tabs and folder menu 6, Repositories drawer and edge handle 3, status chips 4, Developer notes 2, Settings launcher 1, context strip text 1. These files are updated in the same change that moves the element; the old DOM stays alive under `layout: "classic"` until P6, so the suite stays green throughout.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `PerfectPlannerShell.jsx` is about 7,000 lines and `styles.css` about 9,000: large, conflict-prone | Extract each new piece into its own component file and stylesheet (`ProjectSwitcher`, `ProjectsPanel`, `StatusSummary`, `ContextDropdown`); touch the shell only to mount them. |
| CSS cascade surprises between old and new layout | Everything new is scoped under `.layout-new`; the audit (G2) runs against both layouts. |
| Soft-remove shelf conflicts with the strict registry validation | Separate storage key, no registry schema change (section 5.3). |
| Removing a project that has live host work | Refuse with the reason (5.6); covered by a test. |
| Two browser windows resurrecting a removed project | Use the registry's own `rebaseBeforeMutation` and storage-event sync; covered by a two-registry test. |
| Focus traps and Escape handling in several popovers | One shared popover hook (the existing `usePopoverDismiss`) and a G4 keyboard run. |
| WebView2 (desktop) renders differently from Chrome | G2/G3 run in Chrome first; native confirmation stays a separate, labelled step with the staged executable. |
| The owner dislikes the result | The `layout` setting reverts instantly; each phase is separately revertable. |
| Another full qualification cycle | Batched into one (section 8.4). |
| **The main stylesheet is almost at its budget.** Measured the way `scripts/verify-performance-budget.mjs` does (gzip level 9): `index-*.css` was 45,800 B against the 46,080 B (45 KiB) limit before P1 and is 46,015 B after the compacted P1 styles, leaving 65 B (total 89,926 B of 92,160 B). My first P1 styles took it to 46,162 B, which would have failed `verify:release`; that was caught only by measuring. | P2-P4 add CSS, so each phase must measure before it is committed. Either the owner approves a budget raise (the budget file's own history shows previous raises were owner-approved) or new styles move into on-demand chunks. Agents must not raise it themselves. |

## 11. Decisions made on the owner's behalf (reversible) and open questions

Defaulted: one noun "Projects"; soft "Remove from list" with Undo and a "Recently removed" shelf; Settings as a gear in the top bar; one Status dropdown instead of four chips; the project tab row replaced by a switcher; the context strip collapsed after the first visit; Developer notes in the right edge drawer handle.

Questions that would change the design (none blocks P0 and P1): (a) keep up to three project tabs next to the switcher, or switcher only; (b) is the right edge drawer the right home for Developer notes; (c) should the context strip start expanded on every new workspace or only on first visit.

Backlog from the same walk, not part of this plan: choose-folder confirmation is below the fold; the Connect agent panel has no agent picker (it chose Codex because Codex is signed in) and returns HTTP 409 before a history exists; the page auto-scrolls after a scan and hides the title; "Define" lands on Blueprint although adding a folder lives on Structure.

## 12. Acceptance statements for a beginner (what "done" means)

1. I can add a folder from any page in two clicks.
2. I can always see which project is open.
3. I can remove a folder from the list in two clicks, am told nothing on my disk changes, and can undo it.
4. I can find Settings in one click and it is not red.
5. No button is ever covered by another button.
6. Every status I could read before, I can still read, in one click.

## 13. P1 status and evidence (2026-11-21)

**Built (local commits in the carryover working tree; not pushed; not on the DANS1 qualified checkout):**

| Change | What | Files |
|---|---|---|
| C-01 | Soft-remove shelf: a removed project's full session is copied to its own storage key (`perfect-planner.removed-projects.v1`) before it leaves the registry; unreadable data is copied aside, never overwritten; nothing is purged automatically. | `src/project/removedProjects.js` |
| C-02 | "Remove from list" on every drawer row with an inline confirm (focus starts on Cancel, Escape cancels), a toast with **Undo** (kept at least 10 s, and kept when the open project changes), a "Recently removed" section (Restore, and a confirmed Forget permanently), the drawer stays open so several folders can be tidied in one go, and removing the last project goes to Home with no project in the address. Provider API: `removeProject`, `restoreRemovedProject`, `forgetRemovedProject`, `removedProjects`. | `src/project/RemovableProjectRow.jsx`, `src/project/ProjectProvider.jsx`, `src/PerfectPlannerShell.jsx`, `src/styles.css` |
| C-03 | Interim overlap fix: while the left drawer is open the Settings button and the toast sit to the right of it, so neither covers the drawer footer. | `src/settings/settings.css`, `src/styles.css`, `src/PerfectPlannerShell.jsx` |
| C-03b | The three new files and this document are registered in the app atlas (`src/engine/appMapRegistry.js`, component C032 and the supporting docs list). | `src/engine/appMapRegistry.js` |

**Evidence** (Chrome owned by the run, never port 9333; web route of the real client on DANS1, 1600x1000, a patched copy of DANS1's own base, not the qualified checkout):

| Check | Result |
|---|---|
| New tests `tests-ui/removed-projects.test.jsx` (20: shelf, provider, row, and end-to-end through the real shell) | 20/20 pass locally and 20/20 on DANS1 |
| Full local UI suite after the changes (two full runs) | 1,030 of 1,031 pass in the first run and 1,029 of 1,031 in the second. `connect-agent-drawer` fails the same way on the clean committed code (pre-existing on this PC). `core-api-session` "agent model label" hit its 20 s limit under full-suite load in the second run only; it passes alone, twice, with the changes. |
| Existing tests touching the drawer (94) | pass |
| Overlap audit, old build, drawer open | **1 covered control**: "Add project" under "Settings" |
| Overlap audit, patched build, drawer open, with and without the toast, five sample points per control | **0 covered controls** |
| Remove, confirm, toast with Undo, Undo, remove the open project, remove another, Restore, Forget (cancel, then confirm) | each step observed in the running app |
| Disk and host data before and after all of that: five sample folders (115 files) and the host data folder (6 files) | byte-identical (digests `7d95ce82bd30ed32`, `1fc3b3470adc9094`) |
| Main stylesheet budget (repo's own method) | 46,015 B of 46,080 B: passes with 65 B of headroom (see the risk table) |
| Atlas coverage | my files registered; 7 other carryover-only files (`docs/R26-DANS1-CONTINUOUS-DELIVERY.md`, the five `fixtures/finish-lines-task/` files, `scripts/stage-r26-dans1.mjs`) are still unregistered and make this test fail on the branch regardless of P1 |
| `tests-ui/connect-agent-drawer.test.jsx` on this PC | fails identically on the clean committed code (pre-existing on this PC; the same suite passed on DANS1 during `verify:release`) |

**Not done in P1, still planned:** the busy refusal (B-1: needs a host field for tasks in progress); the unexplained "generated" badge and the small remove icon (P2/P5). The inline confirm inherits the drawer's body font instead of the monospace used elsewhere (polish). (B-2, a restored project returning to its old place, was done afterwards, see 13a.)

### 13a. First slice of the header changes, tested on localhost (2026-11-21, same day)

Built as the smallest version of C-10 and C-11 that needs **no new CSS** (the stylesheet budget is saturated): it is not the full redesign in section 4, and P2-P4 are otherwise not started.

| Change | What | Files |
|---|---|---|
| C-10a | **The grey/cream context strip is a dropdown.** "Hide details" collapses it to the Purpose line; "Why this page?" brings back Required outcome and Unlock next. The choice is remembered on this device (`perfect-planner.context-details.v1`); open is the default, so a first visit shows all three and the "you are here" contract holds. | `src/PerfectPlannerShell.jsx` |
| C-11a | **The project tab row shows at most four tabs, always including the open project, with "+N more"** opening the folder menu, which lists every project and has a new "Manage or remove projects..." entry that opens the drawer where removal lives. This stops the pile from filling the header. | `src/PerfectPlannerShell.jsx` |
| C-02b | **A restored project returns to its old position** (the registry's `upsert` takes an optional `index`; the position is saved with the shelved copy). "Recently removed" rows put the name and time on separate lines. | `src/project/projectRegistry.js`, `removedProjects.js`, `ProjectProvider.jsx`, `src/PerfectPlannerShell.jsx` |

**Evidence.** The built client was served by `serve-local` on `127.0.0.1:4590` and driven in the owner's own Chrome tab (browser tools; look at the screen as it happened): six folders added through the real "Choose app folder" and "Approve read-only scan" buttons gave three tabs, the open one and "+2 more"; "Hide details" left only Purpose and the button became "Why this page?" (stored as `collapsed`); "+2 more" listed all six folders plus "Manage or remove projects..."; that opened the drawer; removal showed the inline confirm, the Undo toast, "+2 more" became "+1 more", "Recently removed" listed the folder; Restore and Undo brought folders back, and a folder removed from position 2 came back at position 2. The in-page overlap audit (five sample points per control) found **0 covered controls out of 97** with the drawer open and the toast showing. Tests: `tests-ui/removed-projects.test.jsx` 24 of 24; registry and project node tests 23 of 23; the full UI suite 1,034 of 1,035 (the one failure is the Connect-agent test that fails the same way on the clean committed code on this PC). A first attempt with the Vite dev server showed a blank page in this Chrome (two CSS modules failed to fetch from the browser although the server returned them); the built client served by `serve-local` is the route that works, and it matches how the earlier DANS1 runs were done. This is web-route evidence, not native-app proof; phone and tablet were not checked (owner decision).

**Stylesheet budget, corrected for the branch.** The numbers in the risk table are DANS1's base. The carryover branch's own base is larger: `index-*.css` 45,977 B and total 92,105 B before P1 (headroom 103 B and 55 B). P1's styles add about 216 B, giving 46,193 B and 92,321 B, **over both limits on the carryover branch**, while DANS1's base stays under (46,015 B and 89,926 B). The 13a changes add no CSS. Landing P1, and certainly P2-P4, needs an owner decision: raise `maxIndividualStylesheetGzipBytes` and `maxTotalStylesheetGzipBytes` (the budget file's history shows earlier owner-approved raises) or move styles into on-demand chunks. An agent must not raise them unasked.

**Not claimed:** nothing here is native-app proof, nothing is on the qualified DANS1 checkout, the ledger is untouched, and no phone/tablet check was made (owner decision). The audit and walk driver used for the evidence lives in the DANS1 run folder `20261121-R26-BeginnerWalk` (`bw.mjs`) and is not yet a repository script; making it one is P0 (C-00).

**To land P1 on DANS1:** port the same change to the qualified checkout, run the focused ledger item, then include it in the single batched `SHIP` cycle (section 8).
