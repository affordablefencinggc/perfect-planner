# M17 · Guarded app intake

[← M00 atlas](./00-map-atlas.md) · [Folder structure: M09](./09-planning-engines.md) · [Local authority: M10](./10-local-authorities.md) · [ClamShield connection: M16](./16-clamshield-connection.md)

An app enters Perfect Planner as evidence before it becomes a plan. Selection grants no read authority; analysis grants no mutation authority; automatic organisation means evidence-backed proposals first and exact approved execution later.

```mermaid
flowchart TD
  SELECT["17a · Receive one directory-only selection"]
  APPROVE["17b · Show candidate and request separate read-only approval"]
  REGISTER["17c · Bind canonical root identity and registry revision"]
  LEASE["17d · Issue run-bound single-use census lease"]
  CENSUS["17e · Produce bounded metadata and hash census"]
  IDENTITIES["17f · Reconcile stable source identities"]
  PROFILE["17g · Profile manifests, languages and dependencies"]
  COMPONENTS["17h · Map files to component ownership"]
  PROPOSE["17i · Propose F-numbered structure with evidence"]
  VALIDATE["17j · Validate and architecture-bind candidate contract"]
  COMPARE["17k · Compare exact census with approved structure"]
  GAPS["17l · Publish aligned, missing, unexpected and skipped truth"]
  CLAIMS["17m · Build non-executable read and write claims"]
  COLLISIONS["17n · Resolve collisions and collect named approval"]
  EXECUTE["17o · Execute bounded ordered changes with rollback receipts"]
  VERIFY["17p · Re-census, verify zero drift and publish completion proof"]

  SELECT --> APPROVE --> REGISTER --> LEASE --> CENSUS --> IDENTITIES --> PROFILE --> COMPONENTS --> PROPOSE --> VALIDATE --> COMPARE --> GAPS --> CLAIMS --> COLLISIONS --> EXECUTE --> VERIFY
  CENSUS -. "large workspace accelerator" .-> C028["C028 · External verification agent bridge"]
  REGISTER -. "native fallback" .-> C019["C019 · Repository census and document index"]
  VALIDATE -. "structure authority" .-> C010["C010 · Folder structure authority"]
  COLLISIONS -. "claim authority" .-> C003["C003 · Collision claim authority"]
  VERIFY -. "evidence" .-> C005["C005 · Evidence and completion bundles"]
```

## Current delivery boundary

| Stage | Current state | Rule |
| --- | --- | --- |
| 17a–17c | Implemented | Native picker plus explicit immutable metadata-only registration. |
| 17d | Missing | Registration is durable, but the census still needs an expiring single-use run capability. |
| 17e | Implemented with limits | Native fallback is capped at 10,000 files, 2 MB per file and 50 MB total; larger projects require authenticated ClamShield paging. |
| 17f–17i | Partial/missing | Registries exist, but one generation-bound coordinator and semantic profiler are not yet connected. |
| 17j–17m | Implemented as guarded engines | Invalid architecture blocks mapping; proposals never authorize mutation. |
| 17n–17p | Partial | Exact single-file approval/execution/rollback primitives exist; batch transactions and final coordinated re-census remain. |

## Intake verdicts

- `SELECTED`: the folder path is visible but nothing has been read.
- `INVENTORY_READY`: bounded evidence exists; architecture mapping is still locked.
- `PARTIAL`: skipped, refused or overflowing artifacts prevent complete coverage.
- `REVIEW_READY`: the exact census is mapped to an approved structure and awaits human decisions.
- `BLOCKED`: identity, revision, capability, schema or evidence binding failed.

No intake verdict permits file movement. Mutation requires the later collision, approval, execution and rollback chain.
