# core/numbering — number series, versions and the stamp

Spec §3.1 and §3.2. Everything is derived from ledger entries; there is no
counter file. Import from `../numbering/index`.

## Series

| Series | Format | Handed out by (its `subject`) |
|---|---|---|
| Ledger entry | `L-000231` | every entry, by the ledger itself |
| Plan version | `P-1` | `plan.approved` |
| Task | `T-14`, `T-14.a2` on retries | `task.created`; the attempt is 1 + count of `task.reopened` |
| Question | `Q-1` | `question.asked` (`data.task`, `data.question`) |
| Decision | `D-1` | `decision.made` (`data.question` when it answers one) |
| Release | `R-1` | `release.cut` and `release.rollback` |

```ts
parseNumber("T-14.a2")          // { series: "T", n: 14, attempt: 2 }
formatNumber("L", 231)          // "L-000231"
nextNumber(entries, "T")        // "T-15": highest ever handed out + 1, so never reused
taskLabel(entries, "T-14")      // "T-14.a2" after one reopen
appendNumbered(ledger, { actor, type: "task.created", summary, refs, data: { change: "feature" } })
installNumberingRules(ledger)   // refuses skipped/reused numbers, unknown tasks,
                                // wrong attempts, non-increasing versions
```

## Versions, releases and the stamp

A release's version is derived from the tasks done since the previous release:
any `breaking` task bumps major, any `feature` bumps minor, otherwise patch.
A task's kind is `data.change` on its `task.created` entry (default `fix`).
The first release is `v1.0.0`.

```ts
cutRelease(ledger, actor, { commit: "9f3c2e1" })
// release.cut R-n, data { release, version, plan, commit, from, to, change }
// from..to is the ledger range since the previous release, inclusive

rollbackRelease(ledger, actor, { to: "R-1", reason: "R-2 broke sending" })
// a NEW release R-n (numbers never go back) with a patch bump, the restored
// release's plan and commit, and data.restores = "R-1"

releaseRange(entries, "R-1")    // the entries R-1 covers
releaseStamp(entries, "R-1")    // "R-1 · v1.0.0 · P-1 · L-000231 · 9f3c2e1"
currentStamp(entries, sha)      // footer: latest release, latest plan, ledger head, sha
```

The stamp's `L-` number is the release entry itself, so the stamp names the
exact point in the ledger the release was cut.
