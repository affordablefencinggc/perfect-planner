# core/lookup — clauses, lookup(ref), search and doc views

Spec §3.3–§3.6. Pure functions over `ledger.entries()`; import from
`../lookup/index`.

## Clauses

Every heading, paragraph and list item of a plan has a clause number. Clause
entries use `subject: "§3.1"` and `data.clause: "3.1"`:

| type | data |
|---|---|
| `clause.added` | `{ clause, kind: "heading" \| "paragraph" \| "item", text }` |
| `clause.changed` | `{ clause, old, new }` (reason required) |
| `clause.withdrawn` | `{ clause }` (reason required) |

A plan version `P-n` is the clause state at its `plan.approved` entry, so
`P-1 §3.1` and `P-2 §3.1` can differ. Numbers never move or get reused; an
insert after §3.1 becomes §3.1.1 (then §3.1.2), and a withdrawn clause stays
listed as withdrawn with its ledger entry. `installClauseRules(ledger)`
enforces this.

```ts
numberMarkdown(markdown)                      // [{ clause: "1", kind: "heading", text }, …]
addPlanText(ledger, actor, markdown)          // clause.added for each block
addClause(ledger, actor, { after: "3.1", text })
changeClause(ledger, actor, "§3.1", text, reason)
withdrawClause(ledger, actor, "§3.1", reason)
planClauses(entries, "P-2")                   // Map of clauses as approved in P-2
```

## lookup(ref)

The agent tool and app search accept `§3.1`, `P-2 §3.1`, `T-14`, `T-14.a2`,
`Q-3`, `D-3`, `R-1`, `L-000231` and `P-2`:

```ts
lookup(entries, "P-1 §2.1")
// { found, kind: "clause", text, status, history, citedBy, tasks: ["T-1"], commits: ["9f3c2e1"] }
```

`history` is the entries about the reference itself, `citedBy` the entries
that cite it in `refs`, `corrects` or answers, `tasks` the tasks implementing
it and `commits` the commit shas the watcher observed for them. Unknown
references come back `found: false` with a plain `problem`.

`search(entries, "reload")` resolves a reference directly, otherwise ranks
clause text and entry summaries by matching words.

`parseImplements(commitMessage)` reads `Implements: P-2 §3.1 (T-14)` from a
commit message (§3.5) for the git watcher.

## Docs as views

Rebuilt from entries every time, so the same ledger gives the same text:
`renderPlan(entries, "P-2")`, `renderReleaseNotes(entries, "R-1")`,
`renderTask(entries, "T-14")`, `renderLedger(entries)`.
