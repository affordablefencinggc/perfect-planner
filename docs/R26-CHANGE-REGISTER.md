# R26 change register

Created 2026-11-21 on the owner's instruction: "do everything properly and thoroughly so we dont miss anything with perfect planners structure". Last updated 2026-11-21 (end of the same session).

This is the single list of every numbered change in the R26 UI work. It follows `AGENTS.md` change accounting: each change keeps its number, failures and unresolved outcomes are shown with the observed failure, the known cause or an explicit unknown, the owner and the next action, and a commit is **not** a verification receipt. A row is `Verified` only when the evidence column names a check that was actually run, and says where. Everything here is web-route evidence on this PC (a localhost build in a headless Chrome, plus unit tests). Nothing here is native-app proof, and nothing was run on DANS1 or in the installed app.

Two series share this register:

- **C-00 to C-14**: the header and menu plan (`docs/R26-HEADER-AND-MENU-PLAN.md`, sections 4, 6 and 13).
- **B-01 to B-22**: findings from three end-to-end "build an app with Planner" runs on this PC (2026-11-21), recorded in `OPEN-CODE-HANDOVER.md`. Run 1 hit a dead end; run 2 got four tasks merged and found the release gap; run 3 repeated the whole journey on the fixed build.

Status words: `Verified` (checked as described), `Built` (code and tests, not seen in a real browser), `Open`, `Decision` (needs the owner; nothing was changed), `Unresolved` (cause unknown), `Superseded` (replaced by another change, reason given), `Not done` (deliberately, reason given).

Gates (plan section 7): G1 unit and component tests; G2 overlap audit at 1280/1440/1600/1920 px; G3 beginner walk replay; G4 keyboard and accessibility; G5 data safety; G6 full regression; G7 independent review and the owner's own look. Phone and tablet are out of scope by the owner's 2026-11-11 decision.

## Standing constraints, and where they stand

- Stylesheet budget (gzip level 9): main sheet 46,080 B, total 92,160 B. Before this register: 46,030 B and 92,158 B (2 B of headroom). **Now 46,007 B and 92,135 B** (headroom 73 B and 25 B): the pager and Developer notes fixes replaced larger rules with smaller ones. Only the owner raises the budget; nothing was raised.
- **`npm run verify:performance` fails on this branch for a reason that predates this work:** "Client package has more than 200 files" (654 files in `dist/client`). 580 tracked files under `public/` (452 of them `public/generated/generations`, 150 `.md`, 230 `.json`, 115 `.html`) are copied into the client package, and they are identical at the commit before this session (`a126721`). The gate stops at the first breach, so it never reaches the stylesheet checks here; the stylesheet figures in this register come from a script that applies the repo's own method (gzip level 9, per file and in total). Owner's call: stop shipping `public/generated`, exclude it from the count, or raise the limit.
- App atlas: new files are registered; the test still lists 7 files that belong to other agents' work (`docs/R26-DANS1-CONTINUOUS-DELIVERY.md`, `fixtures/finish-lines-task/*`, `scripts/stage-r26-dans1.mjs`).
- Source commits are local and unpushed (owner decision pending); docs are pushed. DANS1's qualified checkout (HEAD `85f15c0`, digest `6b04a3a9`) and the installed app were not touched.
- The ledger invariants were not bent: only the gate writes `task.done`, after the approved test passes on the merged code (spec 5.1); no ledger entry type was added.

## Gate results (this PC, 2026-11-21)

| Gate | Result |
|---|---|
| G1 / G6 UI suite | 1,065 of 1,066 pass. The one failure, `connect-agent-drawer.test.jsx`, also fails on the commit before this work (`a126721`) on this PC and passes on DANS1. |
| G6 core type-check | `tsc -p tsconfig.core.json` clean. |
| G6 core suite | See "Core suite" below. |
| G2 layout audit | `scripts/ui-layout-audit.mjs` (C-00) on run 3 (a real project with finished work), 24 pages (4 widths x 6 screens). **Before the fixes: 17 violations (8 controls covered, 9 floaters over text). After: 0 covered, 0 floaters over text, 0 horizontal overflow**; 7 controls sit under the full-width Operations bar at rest and can be scrolled clear (reported as under-bar, not hidden). Screens audited: Home, Deep planning, Plan, Decisions, Tasks, Ship. Not audited: Define sub-pages, Prove, Index, the Settings workspace, any open drawer or popover. |
| G3 beginner walk | Run 3 is a complete replay of the journey (folder, scan, idea, answers, roadmap, approve, four tasks through the gate, release). It is hand-driven; there is no repo-owned replay script yet. |
| G4 keyboard / accessibility | Not run. |
| G5 data safety | Not run for the new screens; the removal and restore paths were covered earlier (C-01, C-02). |
| G7 independent review | Not done. |

## Series C: header and menu plan

| ID | Change | Status | Evidence / next action |
|---|---|---|---|
| C-00 | Repo-owned layout audit (gates G2) | Verified | `scripts/ui-layout-audit.mjs` + `tests/ui-layout-audit.test.mjs` (11 tests). Real run on run 3: see G2. Looks only; never clicks; own temporary or kept profile; refuses phone and tablet widths. The beginner-walk replay half of C-00 is not built. |
| C-01 | Removed-projects shelf | Verified | 25 tests; headless Chrome. |
| C-02 | Remove from list with confirm and Undo | Verified | Same. |
| C-03 | Interim overlap fix | Superseded | The floating Settings launcher was deleted; Settings is a gear in the top bar. |
| C-04 | Single Projects panel | Verified | Headless Chrome. |
| C-04a | Search above six projects | Built | `tests-ui/removed-projects.test.jsx` (seven and six projects). Not seen in a browser. |
| C-05 | Layer-contract tokens (`--z-popover`, `--z-toast`) | Not done | The audit (C-00) now guards the class of overlap the tokens were meant to prevent, and the observed overlaps are fixed (B-09). A token refactor touches many rules with 25 B of headroom for little gain. Owner may still want it. |
| C-06 | Developer notes into an edge handle | Verified | It is now a right-edge handle like Projects and Inspector. Audit: its 4 over-text violations are gone; test pins the classes; screenshot `run3/audit-after/1600-plan.png`. |
| C-07 | One-row dark bar; version and date to About | Built | The Status button gives one row (139 px to 95 px); version and date still sit under the brand. Cosmetic; open. |
| C-08 | Status dropdown | Verified | Status toggle, headless Chrome. |
| C-09 | Gear in the bar; ellipsis trimmed | Verified | Gear verified earlier. C-09a below. |
| C-09a | Organisation entries Advanced-only | Verified | Real browser: both entries `display: none` in Simple, shown in Advanced; test pins the class and the CSS rule. |
| C-10 | Collapsible context strip | Verified | Whole header collapses; remembered per device, not per workspace (the plan wanted per workspace). |
| C-11 | Project switcher replacing the tab row | Decision | Tabs are capped at four with "+N more". A real switcher is a look-and-feel change (and CSS) for the owner to choose. |
| C-12 | `layout: classic | new` setting | Superseded | Decision on the owner's behalf: the redesign shipped directly after the owner asked for it; each step is a local commit and can be reverted. Please confirm. |
| C-13 | One vocabulary | Built | Done: "Projects" (list and menu), "Project tabs", "Add project folder"; no retired name remains in labels (`git grep` of aria-labels and button text). Kept on purpose: the onboarding button "Choose app folder" (used in many tests and scripts; owner's call). |
| C-14 | Batched qualification and owner screenshot review | Open | Needs the owner: release approval digest `6b04a3a9` and an independent verifier. The qualified checkout does not contain any of this work. |

## Series B: build-test findings

Evidence: `OPEN-CODE-HANDOVER.md` (three 2026-11-21 entries) and this register. Runs used throwaway sample repos, headless Chrome on its own profile, and a scripted worker over the MCP bridge (token file path only; the token was never read).

| ID | Finding (what a beginner saw) | Cause | Status and evidence |
|---|---|---|---|
| B-01 | "Unlock next" kept asking for evidence that existed; Tasks showed folder-evidence copy. | The generic imported-project copy replaced a core screen's own copy. | **Verified.** 4 tests; run 3: the strip reads "Answer the hard questions…" and "Start a worker on each task…". The planning unlock now says "Answer the blocking questions, then approve the plan." |
| B-02 | "No Demo tasks, people, dates…" in a real project. | Fixed string. | **Built.** Reworded; shares the line with B-22 (tested there). |
| B-03 | "Approve plan" said nothing about the roadmap or that tasks cannot be removed afterwards. | `ApprovePanel` showed only the approval message. | **Verified.** 2 tests; run 3: note plus "Check the roadmap first", which opens the Roadmap tab. |
| B-04 | After a plan change the card still said "Plan approved". | The heading ignored whether the approval was current. (My first diagnosis, a stale refresh, was wrong: the button had already changed.) | **Built.** Heading now "Plan changed since it was approved"; test. |
| B-05 | Red "NOT contained". | Jargon, and red for a risk that is not a hard stop. | **Verified.** Amber "No sandbox: runs as you"; run 3. |
| B-06 | A worker's question was only on Decisions, mixed into "Waiting for you (11)". | Tasks overview carried no questions. | **Verified.** Core: 2 tests; UI: 6 tests; run 3: notice on the card, button to Decisions, worker question first with an explanatory line, notice disappears once answered. |
| B-07 | "Done when" hidden before a worker starts. | Shown only once a test existed. | **Verified.** Core + UI + run 3. |
| B-08 | "Approve diff" greyed with no reason. | Needs the loaded diff. | **Verified.** Run 3: "Open the diff first, then approve it." and disabled. |
| B-09 | A floating pager covered a plan card; the Developer notes pill covered text. | Sticky and fixed overlays. | **Verified.** See C-06 and G2; the pager now sits at the right edge. |
| B-10 | The git folder was asked again. | A separate confirmation step. | **Built.** Says the folder was filled in for you; a duplicated effect was removed; test. Not seen in a browser. |
| B-11 | Finished task folders stay with no tidy-up. | Preserve-first by design. | **Decision.** A disposition workflow is a later item in `AGENTS.md`. Unchanged. |
| B-12 | A release could not be cut anywhere. | `cutRelease` had no caller. | **Verified.** New `GET /release` and `POST /release/cut` (person's act, bound to the fingerprint of what was shown, open tasks must be acknowledged); new Ship screen; Release lands on Ship once a core project has started (even with the old saved default). Core: 4 tests through the real task loop; UI: 6 + navigation tests; **run 3: R-1 v1.0.0 cut from the screen, stamped `R-1 · v1.0.0 · P-1 · L-000195 · 8523708`, listed under "Releases so far".** Not built: rollback and any deploy (a release records the project folder's commit and deploys nothing, and the screen says so). |
| B-13 | The last roadmap task could never pass. | Its done-when needed a ledger entry no repo test can read. | **Verified.** Now "Make the first release ready" (`npm test` passes on a clean checkout); the release itself is the Ship screen. Run 3: a worker did it through the gate. |
| B-14 | A redundant task cannot be removed after approval. | No ledger entry retires a task. | **Decision.** Needs a new person-only entry type with a required reason (like `clause.withdrawn`); it changes the signed ledger schema and the qualified candidate is digest-bound. Prevention shipped instead (B-03, B-17, the Leave-out buttons). |
| B-15 | A worker could not say "already satisfied". | Gate invariant plus a terse message. | **Verified (message only).** The refusal now says to use `ask_main` and never fake a test; core test; real message seen in run 3. The real fix needs B-14. |
| B-16 | A weak default recommendation contradicted the starter's suggestion. | The pack ignores the starter. | **Verified.** Steps back to a plain line and an ordinary option; answered questions show no live recommendation; written-words suggestions handled; 5 tests; run 3 on three cards. |
| B-17 | A command-line starter produced App shell, Main layout and Framework tasks. | The Stack rule adds them until the UI-framework question is answered with a decline. | **Verified.** Those tasks now carry a note naming the open question; using the starter's suggestion removes them (core: 2 tests; run 3 both ways). A starter still answers nothing. |
| B-18 | The first test went in `test/`, not the plan's `tests/`. | The brief did not name the plan's file scope. | **Verified.** Brief says where the plan expects files; core test; real brief files in run 3. |
| B-19 | Pointer clicks on approve/start/merge buttons were sometimes ignored in run 1. | Unknown; driver timing not excluded; real trusted events reached the buttons in two probes. | **Unresolved.** Runs 2 and 3 used in-page clicks and saw no failure. Not called an app bug. |
| B-20 | The Release stage showed "0 tasks" for a project with finished work. | It opened the browser-side draft ledger. | **Mitigated.** Release now opens Ship for a core project. The old "To-do / Ledger" sub-page still reads the browser-side drafts; B-22 explains that on the pages that carry its verdict. |
| B-21 | "writes a record through Test fixtures" for a tool that stores nothing. | One wording for every data node. | **Built.** Fixtures and build artifacts have their own done-when; core test. Not seen in a browser (those tasks were left out). |
| B-22 | The Plan page said "4 of 4 merged" beside "Not done yet". | Two truth systems: the old folder-approval records (browser side) and the project ledger. | **Built.** Once the ledger has started, the old verdict reads "Folder approvals not done yet" and says it is a separate step (eight call sites); test. The deeper fix (one truth, or removing the old verdict) is the owner's design call. |

## Core suite on this PC

Whole suite on the final code: **2,261 passed, 6 failed**, 10 expected-fail, 88 skipped (154 files; 718 s). The 6 failures are `core/attack/approved-test` (1), `core/attack/oddrepos` (3), `core/host/routes/mvp` (1), `core/host/routes/repos` (1) and `core/host/windowsCwdSearch` (1), counted as 7 lines because one is reported twice. **The same 6 fail identically on a clean checkout of the commit before this session's work (`a126721`)**: five are `EPERM: operation not permitted, symlink` (this Windows account may not create symlinks) and one is a `cmd.exe` current-folder quirk. None touches anything changed here. They are expected to pass on a machine that can create symlinks (DANS1), which was not tried. The earlier run's seventh failure was a roadmap test I added while the run was in flight; it passes now.

Core tests added or changed by this work: `core/host/routes/release.test.ts` (4, through the real task loop), `tasks-questions.test.ts` (2), `worker-brief.test.ts` (2), `planning-template.test.ts` (+2), `roadmap.test.ts` (+1), `mcp/service.test.ts` (+1); and the planning, numbering, lookup and rollback suites still pass.

## Held for the owner

- **B-14 / B-15:** a person-only `task.withdrawn` entry (reason required, history kept). It changes the signed ledger schema.
- **B-11:** the disposition workflow for left-behind task folders.
- **B-22:** one source of truth for the Plan and Build pages' verdicts.
- **C-11:** a project switcher, and what it should look like.
- **C-12:** confirm the layout flag is dropped.
- **C-13:** whether "Choose app folder" should become "Add project folder".
- **C-14:** the release approval (digest `6b04a3a9`) and an independent verifier; pushing the local source commits.
- **Releases:** rollback and any deploy are not wired; a release only records a commit.
- **`verify:performance`:** the file-count breach caused by `public/generated` (see the standing constraints) blocks the gate on this branch; it was already there.

## What this register does not cover

Define sub-pages, Prove, Index and the Settings workspace were not audited; the beginner-walk replay is not a repo script; keyboard and accessibility (G4), data safety for the new screens (G5) and independent review (G7) are not done; the native app, the installed app and DANS1 were not touched.
