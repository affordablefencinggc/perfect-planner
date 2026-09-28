# M11 · Execution and collaboration runtime

[← M10 local authorities](./10-local-authorities.md) · [Next: M12 integrity and proof →](./12-integrity-proof-release.md)

```mermaid
flowchart TD
  INDEX["11a · C007 · exact indexed edit surface"]
  COLL["11b · C003 · cleared collision set"]
  SESSION["11c · C011 · durable worker session"]
  BELT["11d · C012 · conveyor state machine"]
  CAP["11e · C006 · deny-by-default capability policy"]
  PROOF["11f · C014 · bounded proof runner"]
  REVIEW["11g · C016 · independent provider review"]
  PRIVATE["11h · C004 · encrypted private draft handoff"]
  CI["11i · C018 · derived and merged-state CI"]
  HUMAN["11j · Explicit named human gesture"]
  STOP["11k · STOP · wait, replan, quarantine or rescan"]
  CANDIDATE["11l · Revision eligible for release assessment"]

  INDEX --> COLL --> SESSION --> BELT
  CAP --> BELT
  PRIVATE -->|quarantined import| COLL
  BELT --> PROOF --> REVIEW --> CI
  HUMAN --> SESSION
  HUMAN --> REVIEW
  BELT -->|scope, identity or dependency mismatch| STOP
  PROOF -->|command, diff or environment missing| STOP
  REVIEW -->|quorum or disposition missing| STOP
  CI -->|not exact merged state| STOP
  CI -->|verified| CANDIDATE
  CANDIDATE -. "portal" .-> M12["11m · M12 · integrity and release"]
```

Git branches and worktrees are optional conveyor transports. The identities, claims, order, proof, and human gates remain mandatory in private-folder mode.
