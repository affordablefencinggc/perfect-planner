# M02 · Component contracts

[← M01 product path](./01-product-workspaces.md) · [Next: M03 trust and authority →](./03-trust-authority.md)

```mermaid
flowchart TD
  ARCH["2a · Approved architecture digest"]
  INV["2b · Exact component inventory C001…Cxxx"]
  COVER{"2c · Exactly one dossier per inventory ID?"}
  STOP0["2d · STOP · missing, duplicate or foreign component"]
  DOS["2e · Component dossier"]

  subgraph REQUIRED["Required dossier sections"]
    ID["2f · Identity · C-number, name, type, F-folder"]
    WHY["2g · Purpose and definitive outcome"]
    BOUND["2h · Responsibilities and non-responsibilities"]
    API["2i · Typed/versioned interfaces"]
    DEP["2j · Dependencies, reason and critical fallback"]
    CLAIM["2k · Exact read/write file claims"]
    DATA["2l · Source of truth, classification, retention, deletion"]
    STATE["2m · Lifecycle states, entry and exit"]
    FAIL["2n · Failure trigger, detection, containment, recovery, proof"]
    SEC["2o · Trust boundary, capabilities, secrets, threats, privacy"]
    PROOF["2p · Tests, acceptance criteria, diff and screenshot rule"]
    DEC["2q · Owned evidence-backed decisions and assumptions"]
    HAND["2r · Cold-start summary, first action, read-first, do-not-assume"]
  end

  VALID{"2s · All sections complete and compatible?"}
  STOP1["2t · STOP · explicit field blockers"]
  FREEZE["2u · C001 · Freeze plan-level component catalog"]
  AUTH["2v · Portal → M03 authority requirements"]
  NAME["2w · Portal → M07 naming, edit scope and live index"]
  EVID["2x · Portal → M05 proof requirements"]

  ARCH --> INV --> COVER
  COVER -->|no| STOP0
  COVER -->|yes| DOS
  DOS --> ID --> WHY --> BOUND --> API --> DEP --> CLAIM --> DATA --> STATE --> FAIL --> SEC --> PROOF --> DEC --> HAND --> VALID
  VALID -->|no| STOP1
  VALID -->|yes| FREEZE
  FREEZE --> AUTH
  FREEZE --> NAME
  FREEZE --> EVID
```

## Current executable inventory

```mermaid
flowchart TD
  subgraph PLAN["Planned contract and structure layer"]
    C008["C008 · Blueprint and rulebook planning"]
    C009["C009 · Viability and repository sonar"]
    C023["C023 · Architecture contract authority"]
    C010["C010 · Folder structure authority"]
    C001["C001 · Component contract registry"]
    C007["C007 · Naming and edit-scope guard"]
    C026["C026 · Architecture map coverage gate"]
  end

  subgraph UI["Visible workspace layer"]
    C020["C020 · Application shell and shared UI"]
    C002["C002 · Component planning workspace"]
  end

  subgraph AUTH["Local authority and collaboration layer"]
    C024["C024 · Shared journal and filesystem locking"]
    C019["C019 · Repository census and document index"]
    C011["C011 · Sessions and explicit confirmations"]
    C017["C017 · Encrypted identity vault"]
    C003["C003 · Collision claim authority"]
    C004["C004 · Private draft exchange"]
  end

  subgraph RUN["Execution layer"]
    C006["C006 · Bounded capability policy"]
    C012["C012 · Execution conveyor and allocation"]
    C014["C014 · Bounded proof command runner"]
    C016["C016 · Independent provider review"]
    C018["C018 · CI and merged-state rehearsal"]
  end

  subgraph TRUTH["Integrity, proof and delivery layer"]
    C013["C013 · Technical debt integrity"]
    C015["C015 · Screenshot evidence and viewing"]
    C005["C005 · Evidence and completion bundles"]
    C022["C022 · Guarantee mutation certification"]
    C025["C025 · Build truth report"]
    C021["C021 · Static hosting and packaging"]
  end

  C009 --> C008 --> C023 --> C010 --> C001 --> C007 --> C026
  C024 --> C023
  C024 --> C019
  C024 --> C011
  C024 --> C017
  C024 --> C003
  C001 --> C002 --> C020
  C007 --> C003
  C011 --> C012
  C003 --> C012
  C017 --> C004 --> C003
  C006 --> C012 --> C014 --> C016 --> C018
  C019 --> C013
  C006 --> C015
  C014 --> C005
  C015 --> C005
  C018 --> C005
  C005 --> C022 --> C025
  C020 --> C021
  C025 --> C021
```

Any component edit invalidates its catalog digest and requires architecture review, collision rescan, and proof-plan refresh. Chat history is never an input to verification.
