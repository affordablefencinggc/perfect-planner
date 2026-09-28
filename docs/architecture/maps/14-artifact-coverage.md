# M14 · Artifact ownership and coverage

[← M13 build and deployment](./13-build-tests-deployment.md) · [Back to M00 atlas →](./00-map-atlas.md)

```mermaid
flowchart TD
  CENSUS["14a · C019 · bounded live repository census"]
  REG["14b · C026 · appMapRegistry"]
  CLASS["14c · Classify every readable artifact"]
  OWN{"14d · Exactly one component or supporting class?"}
  MISS["14e · INCOMPLETE · unmapped artifact list"]
  AMBIG["14f · INCOMPLETE · ambiguous owner list"]
  EXIST{"14g · Every registered artifact exists?"}
  STALE["14h · INCOMPLETE · stale map entry"]
  MAPS{"14i · Every map portal valid and reachable from M00?"}
  ORPHAN["14j · INCOMPLETE · orphan map or portal"]
  COMPLETE["14k · COMPLETE · 100% classified current census"]
  CHANGE["14l · File create, rename or delete"]
  RECHECK["14m · Re-index and rerun coverage gate"]
  NATIVE["14o · C019 · native registered-root census receipt"]

  NATIVE --> CENSUS --> CLASS
  REG --> CLASS --> OWN
  OWN -->|none| MISS
  OWN -->|more than one| AMBIG
  OWN -->|exactly one| EXIST
  EXIST -->|no| STALE
  EXIST -->|yes| MAPS
  MAPS -->|no| ORPHAN
  MAPS -->|yes| COMPLETE
  CHANGE --> RECHECK --> CENSUS
  MISS --> RECHECK
  AMBIG --> RECHECK
  STALE --> RECHECK
  ORPHAN --> RECHECK
  COMPLETE -. "atlas closes" .-> M00["14n · M00 · map atlas"]
```

“Complete map” means 100% of the current bounded registered-root census is classified, every component artifact has one owner, every registered artifact exists, and every map is reachable. The percentage is recomputed whenever the workspace changes. Intake is metadata-only; no organisation proposal may mutate files until a separate exact change set is reviewed and approved.
