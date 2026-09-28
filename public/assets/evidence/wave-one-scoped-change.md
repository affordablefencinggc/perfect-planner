# Wave one · scoped change evidence

Captured: 2026-09-02 (Australia/Brisbane)

This workspace has no Git metadata, so this is an honest behavioral change manifest rather than a fabricated line diff.

| Scope | Before | After | Files | Proof |
|---|---|---|---|---|
| C010 architecture binding | Folder plans could freeze or materialize without naming the exact approved architecture head. | Assessment, freeze, HTTP publication, registry summaries, successor comparison, and materialization require the exact architecture digest and positive revision. Missing, stale, or mismatched heads create nothing. | `src/engine/folderContractEngine.js`; `src/node/folderContractStore.mjs`; `src/node/folderContractHttp.mjs`; `src/node/folderContractMaterializer.mjs` | 31/31 focused folder/Blueprint tests pass. |
| C014 bounded proof output | Child stdout/stderr could grow until process or host limits intervened. | Independent 1 MiB stdout/stderr and 2 MiB combined defaults terminate overflow, truncate at the exact ceiling, and journal `proven: false`. Invalid limits refuse before spawn. | `src/node/proofRunner.mjs` | Focused overflow and merged-state consumer tests pass. |
| C026 map address discovery | A new Mermaid map needed manual addition to the numbering test list. | Tests reconcile `appMapRegistry.maps` to exactly one numbered document and reject missing, duplicate, or unregistered maps before checking every node address. | `tests/map-node-addresses.test.mjs` | 8/8 map atlas/address tests pass. |
| C020 deep-link truth | Workspace changes read the initial query but did not update it. | Every workspace/phase change replaces the current query with the exact visible surface. | `src/PerfectPlannerShell.jsx` | Local in-app verification observed `?workspace=plan` then `?workspace=structure`; production build passes. |

Whole-suite gate: 278/278 tests pass, zero failed, zero skipped. Production build passes. Component catalog remains intentionally `BLOCKED`: 26/26 dossiers, 83 interfaces, 65 file claims, 37 unresolved planning questions, zero naming blockers, zero file collisions.
