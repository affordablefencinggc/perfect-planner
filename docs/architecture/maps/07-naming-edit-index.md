# M07 · Naming, edit scope and live index

[← M02 component contracts](./02-component-contracts.md) · [Next: M04 collision conveyor →](./04-collision-conveyor.md)

```mermaid
flowchart TD
  FOLDER["7a · Frozen folder contract Fxxx"]
  COMP["7b · Frozen component dossier Cxxx"]
  NAME["7c · Distinct scope label, definition and NOT-THIS boundary"]
  POLICY["7d · Allowed roots, required terms, forbidden vague stems"]
  CLAIM["7e · Exact path, access, reason, task and owner"]
  CHECK{"7f · Name and path unambiguous?"}
  BLOCKNAME["7g · REFUSE · rename before approval"]

  subgraph INDEX["Incremental ownership index"]
    EVENT["7h · Create / change / delete observation"]
    CENSUS["7i · Bounded regular-file census; refuse links"]
    HASH["7j · Stable source ID, SHA-256 and revision state"]
    TERMS["7k · Path, symbol and lexical term index"]
    OWNER["7l · C-number, task, scope label and exact claim"]
  end

  SEARCH["7m · Instant search query"]
  RESULT["7n · Ranked files with component ownership and state"]
  EDIT["7o · Proposed edit: plan + architecture + Cxxx + task + path + access"]
  AUTHORIZE{"7p · Exact indexed claim match?"}
  WRITE["7q · AUTHORIZED · pass to collision/session gate"]
  REFUSE["7r · REFUSED · no filesystem write"]
  RECOVER["7s · Amend dossier → approve successor → re-index → collision rescan → new claim"]

  FOLDER --> NAME
  COMP --> NAME --> POLICY --> CLAIM --> CHECK
  CHECK -->|no| BLOCKNAME
  CHECK -->|yes| EVENT --> CENSUS --> HASH --> TERMS --> OWNER
  SEARCH --> TERMS --> RESULT
  RESULT --> EDIT
  EDIT --> AUTHORIZE
  OWNER --> AUTHORIZE
  AUTHORIZE -->|yes| WRITE
  WRITE -. "portal" .-> M04["7t · M04 · Collision and conveyor"]
  AUTHORIZE -->|no| REFUSE --> RECOVER --> COMP
```

## Example that must not pass

```mermaid
flowchart TD
  BAD1["7u · audit.js · meaning unknown"]
  BAD2["7v · site-audit.js · partly overlaps"]
  AMBIG{"7w · Can a worker distinguish them from name + owner alone?"}
  STOP["7x · NO · block both names"]
  GOOD1["7y · activity-event-audit.js · C-ACTIVITY"]
  GOOD2["7z · jobsite-inspection-audit.js · C-JOBSITE"]

  BAD1 --> AMBIG
  BAD2 --> AMBIG
  AMBIG --> STOP
  STOP --> GOOD1
  STOP --> GOOD2
```

A search result is not edit permission. It is a fast route to the exact component contract. The pre-write gate still requires the current architecture digest, component, task, path, access, collision clearance, and worker claim.
