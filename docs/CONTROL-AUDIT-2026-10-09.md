# Control audit and Settings, 2026-10-09

Every interactive control in the app was traced to its handler and classed LIVE, DEAD, BROKEN,
UNAVAILABLE-UNLABELLED or UNAVAILABLE-LABELLED. Dead or broken controls were wired, relabelled or
disabled with a visible reason. Nothing shows fake success.

**Totals:** about 270 controls across 6 areas. 9 fixed or relabelled (3 of them now disabled with a visible reason), 0 removed,
plus 1 new Settings page (21 controls) and 2 new entry points. Everything else was already live.

## Settings page (new)

| Control | Before | After | Test |
|---|---|---|---|
| Detail level Simple / Advanced | only in the context bar | also in Settings, same saved preference | settings-workspace: every control writes a saved setting |
| Theme Warm ledger / High contrast | did not exist | live; Dark is shown disabled "not available yet" | settings-workspace + dark-theme test |
| Text size Standard / Large / Larger | did not exist | scales the whole app | shell test checks zoom 1.1 |
| Reduce motion | did not exist | stops worker laps and transitions | shell test checks data-reduce-motion |
| Open the app on Home / Last page | did not exist | applied at launch | model + control test |
| Define / Coordinate / Prove button opens … | did not exist | top-bar stage button lands there | shell test |
| Open <page> links for every stage page and Index | did not exist | navigate and close Settings | "page links navigate and Back closes" |
| Worktree mode, Review preset, Orchestration rounds, Budget cap, Use Jev as reviewer | did not exist | saved and written into the agent brief; Planner gates unchanged. The app does not run Jev reviews itself yet, and the help text says so | control test + agent brief test |
| Jev API key (masked) Save / Remove | did not exist | Windows Credential Manager only; status-only replies; field clears after save; key never in page, storage or brief. On macOS and Linux the field is disabled with "Not available yet on this system" and nothing is stored | "Jev key goes to the keychain…", Rust unit tests, analyzer guard |
| Copy agent defaults | did not exist | copies the brief; says so if the clipboard is blocked | clipboard test |
| Open the operations console on launch, Console opens on, Show Developer Notes | did not exist | applied at launch | "launch preferences open the console…" |
| Notices stay for 3 / 6 / 10 s / Until closed | fixed 6 s | applied to every notice | "notices close after the chosen time…" |
| Reset all settings (asks first) | did not exist | restores defaults, leaves projects and the keychain alone | "reset asks first…" |

## Top bar and More actions

| Control | Where | Before | After | Test |
|---|---|---|---|---|
| Red **Settings** button (bottom left, every page) | PerfectPlannerShellCore | did not exist | opens the Settings page; pressed again closes it | settings-workspace: "the red Settings button and the More actions item open the page" |
| More actions → **Settings** (red row at the bottom) | TopBar | did not exist | closes the menu and opens Settings | same test |
| Stage buttons 01 Define … 05 Release | TopBar | LIVE, always opened the first page | open the page chosen in Settings (default unchanged) | settings-workspace: Coordinate opens Collisions after the setting |
| People & roster, Delivery calendar, Agent connection, Collision review, Runtime & connections, MCP access, Diagnostics console, Invite, Organization settings, Export project record | TopBar → More actions | LIVE or UNAVAILABLE-LABELLED (roster/forecast/org service not connected, each says so) | same | existing: perfect-planner-shell, shell-truthfulness-regression |
| Top metric chips (Roster, Agent connection, Forecast, Collision check) | TopBar | LIVE (open their popovers); say "not connected / unavailable" honestly | same | existing: shell-truthfulness-regression |
| Connect agent | TopBar | LIVE (drawer owned by the local wide-layout branch, not touched) | same | existing: connect-agent-drawer |

## Home, drawers, plan map

| Control | Where | Before | After | Test |
|---|---|---|---|---|
| Registry drawer close | RepositoryDrawer | LIVE | same | existing: perfect-planner-shell |
| Project registry row (select project) | RepositoryDrawer | LIVE | same | existing: perfect-planner-shell |
| Demo sample plan rows | RepositoryDrawer | UNAVAILABLE-LABELLED (disabled, reason) | same | existing: demo-honesty |
| Footer "New demo plan" | RepositoryDrawer | DEAD-ish: label promised creating a plan, only navigates to Blueprint | relabelled "Open demo blueprint" (honest) | manual: label change; navigation unchanged |
| Footer "Find demo item" / "Project home" / "Add project" | RepositoryDrawer | LIVE (navigates index/home/structure) | same | existing: perfect-planner-shell |
| Inspector close | InspectorDrawer | LIVE | same | existing: inspector-imported-truth |
| Inspector proof checkboxes (read-only, disabled) | InspectorDrawer | UNAVAILABLE-LABELLED | same | existing: demo-honesty |
| Inspector "Approve next gate" | InspectorDrawer | UNAVAILABLE-LABELLED (disabled, Demo reason) | same | existing: demo-honesty |
| OwnerBadge profile popover (hover/focus/click/Enter/Esc) | OwnerBadge | LIVE | same | existing: perfect-planner-shell |
| EdgeHandle | EdgeHandle | LIVE (calls onClick) | same | existing: perfect-planner-shell |
| Plan node card select | PlanNode | LIVE (opens inspector) | same | existing: perfect-planner-shell |
| Head orchestrator character | HeadOrchestrator | LIVE, labelled sample | same | existing: demo-honesty |
| Phase map: return, phase bezel, node pill | PhaseMap | LIVE | same | existing: perfect-planner-shell |
| Plan filters All/Unbuilt/Untested | PlanWorkspace | LIVE | same | existing: perfect-planner-shell |
| Quick brief toggle / outside-click close | PlanWorkspace | LIVE | same | existing |
| Copy handoff | PlanWorkspace | BROKEN: showed "Copied" even if clipboard missing; rejection unhandled | shows "Copied" only after write resolves, else "Copy failed" | tests-ui/demo-honesty.test.jsx: "Copy handoff says so..." and "reports Copied only after..." |
| Plan page up/down | PlanWorkspace | LIVE (scrollBy) | same | manual: code trace |
| Phase capsule -> map | PlanWorkspace | LIVE | same | existing |
| Project folders menu button, project rows, tabs | WorkspaceContextBar | LIVE | same | existing: perfect-planner-shell |
| Add another project folder / Open Demo / empty tab | WorkspaceContextBar | LIVE | same | existing |
| ViewModeToggle Simple/Advanced | ViewModeToggle.jsx | LIVE | same | existing: view-mode-toggle |
| Stage subnav buttons | WorkspacePageNavigation | LIVE | same | existing |
| Home next action, Explore Demo | ProjectHomeWorkspace | LIVE | same | existing: project-home-model-integration |
| Refresh architecture/folders/components, Check planning approval, Review Ledger | ProjectHomeWorkspace | LIVE (disabled while refreshing/no provider) | same | existing: architecture-refresh etc. |
| Demo home: Drop your app, stage tiles, Resolve collisions, Open allocation, View evidence | ProjectHomeWorkspace | LIVE | same | existing |
| Gate action "Return to Structure / Choose app folder" | ProjectWorkspaceGate | LIVE | same | existing: project-truth-gate |
| DemoSampleNotice (badge/reason) | src/demo | non-interactive | same | existing: demo-honesty |

## Demo stage pages (Index, Build, Allocation, Integrity, Evidence, Ledger, Collisions)

| Control | Where | Before | After | Test |
|---|---|---|---|---|
| Close project index | IndexWorkspace | LIVE (navigates home) | same | existing: perfect-planner-shell.test.jsx |
| Start at P1 | IndexWorkspace | LIVE (opens Plan, phase P1) | same | demo-stage-controls: Index filter...Start at P1 |
| Index search input | IndexWorkspace | LIVE | same | demo-stage-controls |
| Index kind filter chips | IndexWorkspace | LIVE | same | manual: code trace |
| Alphabet jump links (A-Z) | IndexWorkspace | BROKEN: real hash anchors pushed history entries and left #index-X in URL (popstate restore path) | preventDefault + scrollIntoView in place | demo-stage-controls: Index letter jump |
| Index entry buttons | IndexWorkspace/openIndexedItem | LIVE | same | existing: project-index tests |
| Resolve before claim | BuildWorkspace | LIVE when blocked; when gate clear still said "Why work cannot start" (untrue) | text/label switch to "Collision order recorded" / "View ledgered orders" when clear | demo-stage-controls: Build (blocked case); clear case manual (needs native authority) |
| Roster, Capacity | AllocationWorkspace | LIVE (open inspector) | same | demo-stage-controls: Allocation |
| Worker cell | AllocationWorkspace | LIVE, but would throw if a worker had zero assignments | disabled + reason when none | manual: code trace |
| Assignment bars | AllocationWorkspace | LIVE | same | manual |
| Resolve collisions / View ledgered orders | AllocationWorkspace | LIVE | same | existing: perfect-planner-shell |
| Create branches unavailable | AllocationWorkspace | UNAVAILABLE-LABELLED | same | existing: perfect-planner-shell |
| Session rows, proof-audit rows | IntegrityWorkspace | LIVE (inspector) | same | manual |
| Retry current report | IntegrityWorkspace | LIVE | same | existing: integrity-current-generation |
| Journey skeleton / Screenshot proof toggle | EvidenceWorkspace | LIVE | same | manual |
| Document ledger button | EvidenceWorkspace | LIVE | same | manual |
| Calendar Months / Weeks | EvidenceWorkspace | DEAD: changed only a text label, no data behind it | disabled with "Not available yet" reason; Days aria-pressed | demo-stage-controls: Evidence calendar |
| Calendar Days + slider | EvidenceWorkspace | LIVE (moves sample time line) | same | manual |
| Journey prev/next page | EvidenceWorkspace | LIVE | same | manual |
| Journey cards | EvidenceWorkspace | LIVE (expand + inspector) | same | existing: perfect-planner-shell |
| Evidence nodes, Fit/Zoom +/- | EvidenceWorkspace | LIVE (clamped 70-120) | same | manual |
| Ledger task rows, Open complete task inspector | LedgerWorkspace | LIVE | same | demo-stage-controls: Ledger |
| Import manifests | CollisionWorkspace | LIVE | same | manual |
| Reset demo census | CollisionWorkspace | LIVE | same | demo-stage-controls: Collision |
| Request approval / Stage proposed order | CollisionWorkspace | BROKEN-silent: when authority call is refused (browser has HTTP adapter), nothing told the user | toast "Approval for X was not recorded: reason" | demo-stage-controls: Collision refused approval |
| Commit assessment, Verify chain | CollisionWorkspace | UNAVAILABLE-LABELLED (disabled until authority) | same | demo-stage-controls: Collision |

## Operations console and runtime panels

| Control | Where | Before | After | Test |
|---|---|---|---|---|
| Operations handle (toggle) | PerfectPlannerShell:OpsDock | LIVE | same | existing: perfect-planner-shell, runtime-event-session-shell |
| Drag bar resize / dblclick collapse / keyboard resize | OpsDock | LIVE | same | existing: perfect-planner-shell |
| Collapse button | OpsDock | LIVE | same | existing |
| Tabs (Logs, Errors, MCP events, Branches, Merge queue, Delivery, Hooks) | OpsDock | LIVE | same | existing |
| Export diagnostics | OpsDock | LIVE (onExportDiagnostics wired; disabled when empty) | same | existing: pp-diagnostics-120 |
| Search / severity filter / Select visible | OpsDock | LIVE | same | existing |
| Event checkbox, Copy this event | OpsDock | LIVE (clipboard w/ manual fallback) | same | existing |
| Copy tray: Paste, Copy all, Clear tray, Replace tray, Dismiss manual copy | OpsDock | LIVE | same | existing |
| Demo branch rows | OpsDock | UNAVAILABLE-LABELLED (toast says sample) | same | existing: demo-honesty |
| Run merge gate (demo) | OpsDock | UNAVAILABLE-LABELLED (disabled + DemoOnlyReason) | same | existing: demo-honesty |
| Delivery stage cards, Guard cards | OpsDock | LIVE (informational: toast shows state detail, no fake action) | same | existing: operations-definition-capture |
| BranchToolsUnavailable | PerfectPlannerShell | LIVE (no controls; role=alert + error event) | same | existing |
| Developer notes toggle/Close/Esc/Add exchange note/form/agent report paging | DeveloperNotes.jsx | LIVE | same | existing: developer-notes |
| Inspect local Git, Copy observation | GitInventoryPanel.jsx | LIVE | same | existing: git-inventory-panel |
| Check / Disconnect planner connection; capability action buttons; Back; Open runtime logs | RuntimeConnectionsPanel.jsx | LIVE (all handlers wired in TopBar/Core) | same | existing: runtime-connections-panel |
| Access radios, Connect an IDE agent, Check agent sessions, Stop broker, Choose app folder | AgentSessionsPanel.jsx | LIVE / disabled when unavailable | same | existing: agent-sessions-panel |
| Pointer markers checkbox, Hide input markers | BrowserInputMarkers.jsx | LIVE; disabled when unavailable | same | existing: browser-input-markers |
| Reload / Open without saved projects / Show saved projects | AppErrorBoundary.jsx | LIVE | same | existing: app-error-boundary |
| Refresh / Show failed check / paging | OperationNativeTaskAttempts.jsx | LIVE | same | existing: native-operation-attempts |
| Refresh check attempts | OperationTaskRunObservations.jsx | LIVE | same | existing |
| OperationTaskAccounting | OperationTaskAccounting.jsx | LIVE (display only) | same | existing: operation-task-accounting |
| Profile select, category checks, Choose npm tool, Refresh status, Prepare, Review, Recover review, Task/Check selects, Run all/selected, Recover/Inspect saved | NativeCheckSetupPanel.jsx | LIVE; disabled with state-based gating | same | existing: native-check-setup-panel |

## 01 Define (Blueprint, Structure, Components)

| Control | Where | Before | After | Test |
|---|---|---|---|---|
| Workspace mode private/hybrid/git | StructureWorkspace | LIVE (part of contract digest) | same | define-controls-audit: workspace mode |
| Collapse all | StructureWorkspace | LIVE | same | define-controls-audit |
| Reset proposal | StructureWorkspace | BROKEN: in a real project it loaded the sample F001.. folders and dropped the approved architecture digest | real project resets to empty plan keeping architecture binding; Demo restores sample | define-controls-audit: Reset proposal x2 |
| Freeze revision | StructureWorkspace | DEAD-ish in Demo: enabled, would publish sample plan to registry | Demo: disabled + "Demo only — sample data"; real: disabled with title reason | define-controls-audit: Demo Structure cannot freeze |
| Open architecture draft | StructureWorkspace | LIVE | same | define-controls-audit |
| Intake/dependencies/paths/editor/validation disclosures | StructureWorkspace | LIVE | same | existing: structure-workspace*.test |
| Choose app folder, drop zone, path input, Approve read-only analysis, Cancel analysis, Retry, Clear and reselect | StructureWorkspace | LIVE (native-unavailable message shown) | same | existing: structure-workspace*, structure-folder-reconnect |
| Pause/Resume, Reveal current map, Show more/Hide files | StructureWorkspace | LIVE | same | existing |
| Add folder, path select, Remove, node editor fields | StructureWorkspace | LIVE | same | existing + define-controls-audit (Add folder) |
| Reconnect folder | FolderReconnectNotice | LIVE | same | existing: structure-folder-reconnect |
| Pause/Resume animation | IndexingActivity | LIVE | same | existing: indexing-activity |
| Looks right / Not applicable / Answer / Save / Cancel / Undo | DiscoveryReviewPanel | LIVE | same | existing: discovery-review-panel |
| Gate/contract/evidence/map/debt/folder tiles (select -> inspector) | BlueprintWorkspace Demo | LIVE | same | define-controls-audit |
| Open structure builder / Open Structure evidence | BlueprintWorkspace | LIVE | same | define-controls-audit |
| Enter planning spine | BlueprintWorkspace Demo | UNAVAILABLE-LABELLED | same | existing: demo-honesty |
| Discovery category tiles | BlueprintWorkspace imported | LIVE | same | existing: blueprint-workspace-imported-truth |
| Template/platform/use-case/fields, Review draft, confirm, Publish architecture | ArchitectureDraftPanel | LIVE | same | existing: architecture-draft-panel |
| Show draft backup, Refresh, Load saved catalog, Rebind, Add component, tabs, fields, Remove rows, Review, confirm, Publish | ComponentDraftPanel | LIVE | same | existing: component-draft-panel-ui241 |
| Review Structure intake | ComponentPlansWorkspace | LIVE | same | define-controls-audit |
| Open/Close map atlas, map tabs, catalog search/select, section toggles | ComponentPlansWorkspace Demo | LIVE | same | define-controls-audit + existing |
| Freeze revision | ComponentPlansWorkspace Demo | UNAVAILABLE-LABELLED | same | existing: demo-honesty |

## 02–05 for real projects (Plan, Collisions, Allocation, Build, Integrity, Evidence, Ledger, Index)

| Control | Where (file:function) | Before | After | Test |
|---|---|---|---|---|
| Requirement row buttons (open in inspector) | ImportedProjectWorkflowWorkspace:RequirementList | LIVE (onSelect) | same | existing: imported-project-workflow-workspace.test.jsx |
| Question cards | ImportedProjectWorkflowWorkspace:QuestionMap | LIVE | same | existing: same |
| Search box (ledger/index) | ImportedProjectWorkflowWorkspace | LIVE (filters rows) | same | existing: same |
| Next honest action | ImportedProjectWorkflowWorkspace:handleNext | LIVE (routes or focuses target) | same | existing: same |
| Truth gate details button / close / Esc+focus trap / optional action | ProjectTruthGate | LIVE (action only renders if onAction passed) | same | existing: project-truth-gate.test.jsx |
| Approve this plan / Approve the current tasks | PlanApprovalStep | LIVE, disabled with visible reasons | same | existing: plan-approval-step.test.jsx |
| Edit tasks in the Ledger | PlanApprovalStep | LIVE (onWorkspace ledger) | same | existing: same |
| Refresh saved planning, Retry original, Resolve withdrawal (+confirm checkbox), mapping checkboxes, Review full saved plan, confirm checkbox, Approve saved plan | PlanApprovalPanel | LIVE, disabled states explained by warnings | same | existing: plan-approval-panel.test.jsx |
| Check overlaps / Check tasks now / Open Ledger / Add files in Ledger / Decision select / Mark resolved / Update decision / Undo / Open Allocation | ProjectCollisionPanel | LIVE | same | existing: project-coordination-panels.test.jsx |
| Add tasks in Ledger | DraftsNotice (ProjectCollisionPanel) | LIVE | same | existing: same |
| Save assignments / Use suggested waves / owner + wave inputs / Check overlaps / Check again | ProjectAllocationPanel | LIVE | same | existing: same |
| Status select / Note / Save status / Copy brief (textarea fallback) / Open blocker workspace / Add proof / Open Ledger | ProjectBuildBoard | LIVE | same | existing: project-index-build.test.jsx |
| Search / result buttons (open workspace, deep-link task) | ProjectIndexPanel | LIVE | same | existing: project-index-build.test.jsx |
| Open Evidence / Collision / Allocation, reviewer + notes, Sign off | ProjectIntegrityPanel | LIVE | same | existing: project-proof-panels.test.jsx, integrity-current-generation.test.jsx |
| Add proof toggle, kind select, format radios, file/link/text inputs, Save proof, Cancel, Remove, thumb/link anchors, Open Structure, Plan tasks in Ledger | ProjectEvidencePanel | LIVE | same | existing: project-proof-panels.test.jsx |
| Viewer name, observation, confirm, Record viewing attestation | ScreenshotViewingPanel | LIVE | same | existing: screenshot-viewing-panel.test.jsx |
| Read shared plan | SharedLedgerReview | UNAVAILABLE-LABELLED (disabled + "Open this registered project in the desktop app") | same | existing: shared-ledger-review.test.jsx |
| Per-task keep local / use shared, Preview combined plan, confirm, Save, Read latest | SharedReconciliationControls | LIVE | same | existing: shared-ledger-review / shared-review-stale |
| Refresh saved reviews | SharedReviewHistory | LIVE | same | existing: shared-review-history.test.jsx |
| Submit saved revision, Refresh submission history, Retry original | TaskDraftDeliveryPanel | LIVE; native-only labelled ("Native delivery is unavailable in this view") | same | existing: task-draft-delivery-panel.test.jsx |
| Refresh map, Open Ledger, Check planning approval, node buttons, Plan the first task | TaskDraftMap | LIVE | same | existing: task-draft-map.test.jsx |
| Refresh draft, Export draft, Revision history, revision buttons, Export revision, Edit Tn, Show archived, editor fields, Save task draft, Discard, Refresh/Export original Saves, withdraw/acknowledge, Continue in new editor | TaskDraftLedger | LIVE | same | existing: task-draft-ledger.test.jsx |

## Verification

- UI tests: `npx vitest run` → 74 files, 585/585 passed.
- 11-step journey: `npm run test:e2e` → 11/11 passed in headless Chromium.
- Node tests: `npm test` → same result as the starting commit in this Linux container (the 49 failures there are
  git-sandbox and Windows-only tests that fail identically on the untouched base).
- Native: `jev_keychain.rs` type-checks for `x86_64-pc-windows-msvc` against windows-sys 0.61.2 and its unit tests pass.
