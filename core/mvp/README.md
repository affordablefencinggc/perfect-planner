# core/mvp — MVP-first stages

Every project is cut into four stages: **MVP, Beta, v1, Scale**. Stage ids
(`mvp`, `beta`, `v1`, `scale`) never change; their display names are
renamable ("MVP" can become "Pilot"). The MVP is done when **one tested
end-to-end user journey** passes and every feature in the MVP is Done.

Owner: the "MVP staging" thread. Everything is a view of the ledger
(`core/ledger`): writes are `decision.made` entries numbered `D-n` through
`core/numbering`, and the board is rebuilt by replaying them. Nothing is kept
outside the ledger, so the board survives restarts and every move has an
author, a time and a reason.

## Two ways in

```ts
import { MockJev, stageExistingProject, stageNewProject } from "../mvp/index";

// Existing code: scan Done / Partial / Missing with file evidence,
// then Jev proposes the MVP line for the user to confirm.
const { scan, proposal } = await stageExistingProject(ledger, new MockJev(), {
  root: projectRoot,
  goal: "Import an existing project, plan it and sign it off",
});

// New project: Jev proposes which planned features belong in the MVP.
await stageNewProject(ledger, new MockJev(), { goal, features });
```

Both validate the advisor's answer (`validateProposal`) before anything is
written, so a misbehaving advisor cannot slip a bad line into the ledger.

## The scan (`scan.ts`)

`scanFeatures(root)` takes features from the first source that applies:

| Source | When | Features |
|---|---|---|
| `registrySource()` | `src/engine/appMapRegistry.js` exists | each `{ id, name, dependsOn, artifacts }` entry, read as text and never executed; follows relative imports and merges `*Artifacts` maps |
| `folderSource()` | any repo | one feature per file in `src/components`, `src/pages`, `app/routes`, one per folder in `src/features` |
| `plannedSource(list)` / `planned` option | features the plan names | matched by id or name; no files means **Missing** |

Status rules (`classify`):

- **Missing**: none of the declared files exist.
- **Partial**: some declared files are missing, or no test covers it, or a
  source file has a stub marker in a comment (`TODO`, `FIXME`, `XXX`, `HACK`,
  "not implemented", "stub") or a `throw new Error("Not implemented")`.
- **Done**: every declared file exists, at least one test exists, no markers.

Tests are paths under `tests/`, `tests-ui/`, `__tests__/` or `e2e/`, files
named `*.test.*` / `*.spec.*`, and journey scripts named `e2e-*`. Every status
carries evidence: one `{ file, line?, note }` per file present, file missing
and marker, with repo-relative forward-slash paths on every OS.

## The board (`board.ts`)

| Call | Rule |
|---|---|
| `recordProposal(ledger, proposal)` | starts a fresh board; clears any confirmation |
| `moveFeature(ledger, actor, id, stage, reason)` | moving to any stage but the MVP needs a **one-line reason** (non-empty, not "TBD", no newline, at most 200 characters), else `MvpError("REASON_REQUIRED")`; moving into the MVP needs none; any move un-confirms the board |
| `renameStage(ledger, actor, stage, name)` | 1 to 40 characters, one line, unique |
| `setJourney(ledger, actor, journey)` | replaces the done-when journey and pulls its features into the MVP |
| `confirmMvp(ledger, actor)` | only a person can confirm (`NOT_A_PERSON`) |
| `boardFromLedger(entries)` | replays the board |
| `missingDependencies(board, features)` | MVP features whose dependencies sit in a later stage, for a warning |
| `mvpDoneWhen(board, entries, features)` | `{ done, journeyPassed, blocking }`: done when confirmed, every MVP feature is Done, and the latest `test.passed`/`test.failed` for the journey's test command is a pass |

`data.mvp.kind` on each entry is `proposal`, `move`, `rename`, `confirm` or
`journey`.

## Jev (`advisor.ts`)

core/mvp talks to Jev only through `MvpAdvisor`
(`proposeMvp(input) → MvpProposal`). Until the check-in thread's `core/jev`
lands, `MockJev` stands in. It is deterministic: the journey is the repo's
end-to-end feature and what it touches (existing code) or the user-facing
features that best match the goal (new project); the MVP is the journey plus
its full dependency closure; everything else gets a later stage and a reason
(missing → v1, partial → Beta, internal hardening → Scale or v1, the rest →
Beta). Swapping in the real Jev is one constructor.

## Reports (`report.ts`)

`scanReport(scan)` and `boardReport(board, features)` return Markdown for the
confirm screen, the PR and the CLI.

## Running the tests

```
npm run test:core
npm run typecheck:core
```

`flow.test.ts` runs the whole flow against this repository: scan, proposal,
a move refused without a reason, rename, confirm, and done-when before and
after the journey test passes.
