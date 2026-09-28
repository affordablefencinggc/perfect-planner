# M12 · Integrity, proof and release

[← M11 execution runtime](./11-execution-collaboration.md) · [Next: M13 build and deployment →](./13-build-tests-deployment.md)

```mermaid
flowchart TD
  GUAR["12a · C022 · truth guarantee matrix"]
  MUT["12b · C022 · mutation certification"]
  DEBT["12c · C013 · technical debt coverage and ratchet"]
  NATIVE_DEBT["12o · C013 · thirteen-file Tauri analyzer receipt"]
  CMD["12d · C014 · command proof"]
  SHOT["12e · C015 · screenshot and viewing proof"]
  EVID["12f · C005 · evidence bundle"]
  REVIEW["12g · C016 · independent review quorum"]
  CI["12h · C018 · merged-state CI"]
  REPORT["12i · C005 · completion report"]
  TRUTH["12j · C025 · generated build truth report"]
  ALL{"12k · Every current predicate true?"}
  NO["12l · NO-GO · named missing conjunction"]
  YES["12m · Release proof and cold-start handover"]

  GUAR --> MUT
  GUAR --> ALL
  MUT --> ALL
  NATIVE_DEBT --> DEBT --> ALL
  CMD --> EVID
  SHOT --> EVID
  EVID --> ALL
  REVIEW --> ALL
  CI --> ALL
  REPORT --> ALL
  TRUTH --> ALL
  ALL -->|no| NO
  ALL -->|yes| YES
  YES -. "packaging portal" .-> M13["12n · M13 · build and deployment"]
```

Zero findings with missing coverage remains UNKNOWN. Native coverage is accepted only when the exact ACL, CSP, command surface, selected-file receipt, and direct no-shell cargo-clippy run all pass. A visual screenshot without scoped diff and viewing proof remains unproven.
