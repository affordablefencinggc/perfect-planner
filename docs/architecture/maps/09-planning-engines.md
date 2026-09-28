# M09 · Planning and architecture engines

[← M08 UI surfaces](./08-ui-shell-workspaces.md) · [Next: M10 local authorities →](./10-local-authorities.md)

```mermaid
flowchart TD
  BRIEF["9a · Business goal, motive, audience and evidence"]
  VIA["9b · C009 · viabilityEngine"]
  SONAR["9c · C009 · sonarEngine"]
  BLUE["9d · C008 · blueprintEngine"]
  RULE["9e · C008 · rulebookEngine"]
  DEBT["9f · C013 · debtEngine + surface scanner"]
  NATIVE_DEBT["9n · C013 · exact Tauri security + cargo-clippy analyzer"]
  FOLDER["9g · C010 · folderContractEngine"]
  COMP["9h · C001 · componentPlanEngine"]
  NAME["9i · C007 · editScopeEngine"]
  ARCH["9j · C023 · architecture contract"]
  GRAPH["9k · C012 · executionEngine"]
  STOP["9l · STOP · exact unanswered contracts"]

  BRIEF --> VIA
  BRIEF --> SONAR
  VIA --> BLUE
  SONAR --> BLUE
  BLUE --> RULE
  NATIVE_DEBT --> DEBT --> RULE
  RULE -->|incomplete| STOP
  RULE -->|compatible and answered| ARCH
  ARCH --> FOLDER --> COMP --> NAME --> GRAPH
  FOLDER -->|invalid path, cycle or missing owner| STOP
  COMP -->|missing dossier, interface, fallback or handover| STOP
  NAME -->|ambiguous name or unclaimed path| STOP
  ARCH -. "freeze portal" .-> M10["9m · M10 · local authorities"]
```

Planning produces contracts and an ordered graph. It does not create code, folders, branches, or green proof as a side effect.
