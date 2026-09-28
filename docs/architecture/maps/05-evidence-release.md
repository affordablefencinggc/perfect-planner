# M05 · Evidence and release proof

[← M04 collision conveyor](./04-collision-conveyor.md) · [Next: M06 private exchange and adapters →](./06-private-exchange-adapters.md)

```mermaid
flowchart TD
  ITEM["5a · Numbered checklist item bound to Cxxx and revision"]
  RULE["5b · Component proof contract"]
  CMD["5c · Approved no-shell command output"]
  DIFF["5d · Scoped code difference"]
  UI{"5e · UI-affecting requirement?"}
  SHOT["5f · Validated nonblank screenshot"]
  VIEW["5g · Named time-bound viewing attestation"]
  META["5h · Environment, command, hashes and timestamps"]
  CONJ{"5i · Every required proof conjunction present?"}
  NO["5j · NO-GO · checkbox stays empty"]
  CAPSULE["5k · Immutable proof capsule"]
  REVIEW["5l · Human and optional 2–3 provider peer review"]
  AGREE{"5m · Quorum clear and disagreements resolved?"}
  CI["5n · Derived/merged-state CI proof"]
  FINAL{"5o · Completion predicate and journal valid?"}
  REPORT["5p · Completion report, evidence bundle and handover"]

  ITEM --> RULE
  RULE --> CMD
  RULE --> DIFF
  RULE --> UI
  UI -->|yes| SHOT --> VIEW
  UI -->|no| META
  CMD --> META
  DIFF --> META
  VIEW --> META
  META --> CONJ
  CONJ -->|no| NO
  CONJ -->|yes| CAPSULE --> REVIEW --> AGREE
  AGREE -->|no| NO
  AGREE -->|yes| CI --> FINAL
  FINAL -->|no| NO
  FINAL -->|yes| REPORT
  REPORT -. "result portal" .-> M01["5q · M01 · Product/release outcome"]
```

The screenshot is proof of visible state, not proof of correctness by itself. The scoped diff is proof of changed code, not proof of visible outcome by itself. The box turns green only when the component’s exact conjunction is true.
