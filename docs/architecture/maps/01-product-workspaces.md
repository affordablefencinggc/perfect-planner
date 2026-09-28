# M01 · Product and workspace path

[← M00 atlas](./00-map-atlas.md) · [Next: M02 component contracts →](./02-component-contracts.md)

```mermaid
flowchart TD
  U["1a · User goal and business brief"]
  IDX["1b · WS-INDEX · Dictionary of the build"]
  BP["1c · WS-BLUEPRINT · Viability, template and rulebooks"]
  ST["1d · WS-STRUCTURE · Folder contract F001…Fxxx"]
  CP["1e · WS-COMPONENTS · Dossiers C001…Cxxx"]
  PL["1f · WS-PLAN · Top-down phases and work packages"]
  CO["1g · WS-COLLISION · Claims and forced resolution"]
  AL["1h · WS-ALLOCATION · Owners, lanes and day ranges"]
  IN["1i · WS-INTEGRITY · Guarantees, debt and authority truth"]
  EV["1j · WS-EVIDENCE · User journey and proof capsules"]
  LE["1k · WS-LEDGER · Every box and current proof state"]
  GO{"1l · Release conjunction true?"}
  STOP["1m · NO-GO · named blockers and recovery path"]
  OUT["1n · Completion report and handover"]

  U --> IDX --> BP
  BP -->|business and architecture questions answered| ST
  ST -->|frozen paths and forward reservations| CP
  CP -->|100% inventory coverage and approved catalog| PL
  PL --> CO --> AL --> IN --> EV --> LE --> GO
  GO -->|no| STOP
  STOP -->|successor plan or missing proof| BP
  STOP -->|work-order or claim issue| CO
  STOP -->|proof issue| EV
  GO -->|yes| OUT

  CP -. "portal: M02" .-> M02["1o · M02 · Component contracts"]
  CO -. "portal: M04" .-> M04["1p · M04 · Collision conveyor"]
  EV -. "portal: M05" .-> M05["1q · M05 · Evidence and release"]
```

The workspaces are separate because each answers a different decision. The Index is the only global dictionary. Detail belongs in its owning workspace and collapses when not needed.
