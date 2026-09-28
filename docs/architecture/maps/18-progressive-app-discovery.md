# M18 · Progressive app discovery

[← M00 atlas](./00-map-atlas.md) · [Guarded intake: M17](./17-guarded-app-intake.md) · [Planning engines: M09](./09-planning-engines.md)

The discovery canvas begins empty. Its stable sections are questions, not presumed architecture. Bounded metadata may add observed file facts or weaker review signals; it can never silently turn a filename into proven architecture, tenancy, permissions, or a live connection.

```mermaid
flowchart TD
  EMPTY["18a · Show blank discovery root and predefined question areas"]
  CENSUS["18b · Receive the exact bounded metadata census"]
  NORMALIZE["18c · Normalize relative paths without returning contents"]
  OBSERVE["18d · Record exact manifest and configuration presence"]
  SIGNAL["18e · Separate naming signals from observed facts"]
  BUCKET["18f · Place evidence in identity, runtime, layers, data, dependency, security and delivery areas"]
  UNKNOWN["18g · Preserve unanswered tenancy, auth and architecture questions"]
  REVIEW["18h · Send evidence and gaps to human architecture review"]
  FREEZE["18i · Freeze only answers backed by an approved contract and proof"]

  EMPTY --> CENSUS --> NORMALIZE --> OBSERVE --> SIGNAL --> BUCKET --> UNKNOWN --> REVIEW --> FREEZE
  CENSUS -. "source" .-> C019["C019 · Repository census and document index"]
  BUCKET -. "discovery model" .-> C030["C030 · Progressive workspace discovery"]
  REVIEW -. "intake state" .-> C029["C029 · Guarded app intake coordinator"]
  FREEZE -. "architecture authority" .-> C023["C023 · Architecture contract authority"]
```

## Certainty contract

| State | Meaning | May turn green? |
| --- | --- | --- |
| Unanswered | No relevant evidence has been indexed | No |
| Review signal | A filename or folder convention suggests a possibility | No |
| Observed | The exact manifest, configuration, workflow, or test path exists in the bound census | Yes, for file presence only |
| Proven | An approved contract plus required execution evidence confirms behavior | Only after later review; discovery cannot issue it |

The first discovery release reads no source contents. Package membership, runtime behavior, identity enforcement, tenant isolation, secret values, connection health, and deployment success therefore remain outside its authority.
