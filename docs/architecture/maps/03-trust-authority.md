# M03 · Trust and local authority

[← M02 component contracts](./02-component-contracts.md) · [Next: M04 collision conveyor →](./04-collision-conveyor.md)

```mermaid
flowchart TD
  USER["3a · Named local user"]
  GESTURE["3b · Explicit operation-bound gesture"]
  UI["3c · React UI · untrusted rendering surface"]
  HTTP["3d · Same-origin guarded local transport"]
  TOKEN["3e · Per-process capability token"]
  ID["3f · Encrypted identity vault"]
  CHECK{"3g · Exact plan, actor, origin, token and CAS match?"}
  REFUSE["3h · REFUSE · no state change"]
  NATIVE["3x · C027 · deny-by-default Tauri shell"]
  RUNTIME["3y · Versioned read-only runtime snapshot"]
  INTAKE["3z · User-selected folder → approved metadata census"]

  subgraph AUTH["Local authorities"]
    A1["3i · Architecture registry"]
    A2["3j · Folder contract registry"]
    A3["3k · Component catalog registry"]
    A4["3l · Collision authority journal"]
    A5["3m · Confirmation and acceptance receipts"]
  end

  FILES["3n · Atomic append-only revision files"]
  READ["3o · Bounded verified redacted read"]
  NEXT["3p · Portal → M04 cleared revision and identities"]

  USER --> GESTURE --> UI --> HTTP
  UI --> NATIVE --> RUNTIME --> UI
  NATIVE --> INTAKE --> UI
  HTTP --> TOKEN
  HTTP --> ID
  TOKEN --> CHECK
  ID --> CHECK
  CHECK -->|no| REFUSE
  CHECK -->|yes| AUTH
  A1 --> FILES
  A2 --> FILES
  A3 --> FILES
  A4 --> FILES
  A5 --> FILES
  FILES -->|rehash, verify chain, verify contract| READ --> UI
  READ --> NEXT
```

## Authority boundary

```mermaid
flowchart TD
  MEMORY["3q · Agent memory or chat"] -->|reference only| UNTRUSTED["3t · Untrusted context"]
  BROWSER["3r · Browser state/localStorage"] -->|preferences only| UNTRUSTED
  PROVIDER["3s · Git, CI, model or browser provider"] -->|evidence only| UNTRUSTED
  UNTRUSTED --> VALIDATE["3u · Revalidate against frozen contracts"]
  VALIDATE -->|matches| LOCAL["3v · Local verified authority"]
  VALIDATE -->|missing or differs| STOP["3w · STOP / UNKNOWN"]
```

The native seam exposes a versioned inert runtime snapshot plus one user-triggered directory chooser, explicit root registration, and a bounded metadata-only census. Selecting a directory grants no read authority; registration and census are separate operations. No file mutation, process, secret, collision, approval, or release authority has moved behind Tauri yet.
