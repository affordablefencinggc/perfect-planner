# Five-stage Project Home and Build workspace proof

## Box checked

- Replaced the ten equal-weight workspace buttons with one Home, five ordered stages, and a separate searchable Index control.
- Added contextual stage sub-navigation so only the pages relevant to the current stage are shown.
- Added a Project Home with the current stage, honest completion, active responsibility, unresolved collision count, and one exact next action.
- Added the missing Build workspace with an eight-station guarded conveyor and mandatory screenshot/code-difference exit proof.
- Preserved direct `?workspace=` links, collapsible side drawers, the separate Evidence workspace, and the collapsed bottom operations dock.

## Screenshot proof

- `project-home-five-stage-navigation.png`
  - SHA-256: `9A365798929C2F355EC05215EFB824A4E5D7C7A028E99262090EEA11848FFE42`
  - Viewed in the isolated in-app preview at `?workspace=home`.
- `guarded-build-conveyor.png`
  - SHA-256: `9C388EF1C229CC1B07A3DCDB579340DF7A928814453A0C79F240B9236D1AA256`
  - Viewed in the isolated in-app preview at `?workspace=build`.

## Scoped code difference

This clean-room directory intentionally has no Git metadata, so the difference is recorded by exact owned surfaces and post-change hashes instead of pretending a Git diff exists.

- `src/PerfectPlannerShell.jsx`
  - Added `stageNavigation`, stable workspace context contracts, `WorkspaceContextBar`, `ProjectHomeWorkspace`, `BuildWorkspace`, and the Index overlay.
  - SHA-256: `5FA14D6CDEA9F1905FB524BF9EE7663118A7A94EFC7E4A3F1224A8F858E69D98`
- `src/styles.css`
  - Added the thin chromium stage navigation, spacious Home, responsive contextual bar, Index overlay, and Build conveyor surfaces.
  - SHA-256: `2FC16E82CBBF102F67D3DE36DD1541E6B1580D322EED0433BCAD298809F70776`
- `tests-ui/perfect-planner-shell.test.jsx`
  - Added staged navigation, Index close, Build deep-link, and workspace visibility coverage.
  - SHA-256: `518EBF5233FE61623013C8C7E24185B6409F7FA304B0A034D236DD508EB959CA`

## Verification

- UI interaction/accessibility suite: 5/5 passed.
- Production build: passed.
- Component catalog: 26/26 complete, 100 interfaces, 79 file claims, zero blockers.
- Honest limitation: release remains NO-GO; this navigation change does not override unresolved collisions, missing native coverage, or unverified hosted CI.
