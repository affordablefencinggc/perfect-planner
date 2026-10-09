# core/ledger — the strict ledger

The ledger is the only source of truth for the core loop (spec §2.1). Every
board, task state, doc and release is a view rebuilt by replaying it. This
README is the interface the other core modules code against; it is stable
from the first commit, and any change to it is announced in the PR.

Owner: the "strict ledger" thread. Sibling modules: `core/numbering`
(number series, version, stamp) and `core/lookup` (clauses, `lookup(ref)`,
search, doc views).

## Running the tests

```
npm run test:core          # vitest, node environment, core/**/*.test.ts
npm run typecheck:core     # tsc --noEmit over core/
```

Both run in CI on Windows, macOS and Linux (`.github/workflows/core-ci.yml`).
Shared setup owned by this thread: `vitest.core.config.mjs`,
`tsconfig.core.json`, `core/tsconfig` settings, the `test:core` and
`typecheck:core` scripts and the core CI workflow. Other core threads add
their tests under their own `core/<module>/` folder and they are picked up
automatically; please do not edit those shared files, ask in your thread.

Imports are relative and extensionless, e.g.
`import { Ledger } from "../ledger/index"`. Everything a sibling needs is
re-exported from `core/ledger/index.ts`.

## Entry shape (spec §2.2)

```ts
type ActorKind = "person" | "agent" | "jev" | "system";

interface Actor {
  kind: ActorKind;
  id: string;          // "looplet-spare", "claude-code", "jev", "watcher"
  model?: string;      // required when kind is "agent" or "jev"
}

interface LedgerEntry {
  n: string;            // "L-000231", assigned by the ledger, only goes up
  at: string;           // "2026-10-09T02:14:05Z", UTC, assigned by the ledger
  actor: Actor;
  type: EntryType;      // see below
  subject: string;      // what it is about: "T-14", "P-2", "Q-3", "R-1", "P-2 §3.1"
  summary: string;      // one line, plain words, never empty or "TBD"
  reason?: string;      // required for decisions, corrections, rollbacks, clause changes
  evidence: string[];   // links: "commit:9f3c2e1", "test-run:88", "file:src/a.ts", URLs
  refs: string[];       // clauses implemented or changed: ["P-2 §3.1"]
  corrects?: string;    // "L-000229" when this entry corrects an earlier one
  data?: Record<string, unknown>;  // type-specific payload, see "Payloads"
  prev: string;         // hash of the previous entry ("0"*64 for L-000001)
  hash: string;         // sha256 of canonical JSON of every field except hash
}
```

`data` is the one addition to §2.2: type-specific payloads (old and new clause
text, the test command, a release's ledger range) need somewhere to live, and
it is covered by the hash like every other field.

Entry types (spec §2.3), exported as `ENTRY_TYPES`:

| Group | Types |
|---|---|
| Plan | `plan.approved`, `clause.added`, `clause.changed`, `clause.withdrawn` |
| Task | `task.created`, `task.claimed`, `task.progress`, `task.blocked`, `task.proof`, `task.done`, `task.reopened` |
| Relay | `question.asked`, `question.answered`, `decision.made` |
| Git | `worktree.created`, `commit.observed`, `collision.detected`, `collision.resolved`, `merge.done`, `worktree.removed` |
| Proof | `test.defined`, `test.approved`, `test.passed`, `test.failed`, `review.verdict` |
| Release | `release.cut`, `release.rollback` |
| Housekeeping | `correction`, `budget.warning`, `chain.acknowledged` |

`chain.acknowledged` is how a person clears a fingerprint break (§2.5).

## Writing

```ts
import { Ledger, FileStore, MemoryStore } from "../ledger/index";

const ledger = await Ledger.open(new FileStore(projectRoot));   // takes the writer lock
const entry = ledger.append({
  actor: { kind: "agent", id: "claude-code", model: "claude-x" },
  type: "task.claimed",
  subject: "T-14",
  summary: "Claimed by worker 2",
  evidence: [],
  refs: ["P-2 §3.1"],
});
// entry.n === "L-000232", entry.hash, entry.prev filled in
ledger.close();   // releases the writer lock
```

`append(draft)` validates, numbers, stamps the time, chains and persists in
one synchronous step, then returns the stored entry. It throws `LedgerError`
with a `code` when a rule refuses the entry:

| code | when |
|---|---|
| `EMPTY_FIELD` | `summary` (or a required `reason`) is empty, whitespace or "TBD" |
| `REASON_REQUIRED` | `decision.made`, `correction`, `release.rollback`, `clause.changed`, `clause.withdrawn`, `chain.acknowledged`, `task.reopened` without a reason |
| `UNKNOWN_TYPE` | `type` is not in `ENTRY_TYPES` |
| `BAD_ACTOR` | missing actor, unknown kind, or an AI actor with no model |
| `BAD_CORRECTS` | `corrects` does not name an existing earlier entry, or a `correction` has no `corrects` |
| `DONE_WITHOUT_PASS` | `task.done` unless the latest run of the task's approved test after its last `commit.observed` (or approval, or reopen) is a `test.passed` (§2.4) |
| `CHAIN_BROKEN` | the chain failed verification on open and has not been acknowledged; all writes stop |
| `NOT_PERMITTED` | the actor's kind may not write this entry type (see "Who may write what") |
| `READ_ONLY` | the ledger was opened read-only, or another process holds the writer lock |
| `RULE` | a rule registered with `ledger.addRule` refused it; also `test.approved` for a command never defined for that task, and `chain.acknowledged` written through `append` (use `acknowledgeBreak`) |

### Who may write what

Checked before every other rule, from `DEFAULT_PERMISSIONS` (or
`Ledger.open(store, { permissions })`):

| Actor kind | May write |
|---|---|
| `person` | any type (`core/people` narrows this per role: owner, helper, viewer) |
| `system` (the gate, the git watcher) | any type except `chain.acknowledged` |
| `agent` | `task.claimed`, `task.progress`, `task.blocked`, `task.proof`, `test.defined` (a proposal), and the relay: `question.asked`, `question.answered` |
| `jev` | `review.verdict`, `question.asked` |

So decisions (`decision.made`), approvals (`plan.approved`, `test.approved`, `release.*`), test results,
`commit.observed`, `merge.done`, `task.created`, `task.done` and
`task.reopened` never come from an agent or Jev: the gate writes results and
done, a person approves. A helper's agent is limited by both this table and
its person's role in `core/people`.

Every open re-checks the stored entries against the same table; an entry
its actor could not have written stops writes as a `permission` break.

**Trust the author, not the payload.** Code that treats an entry as a
person's decision, confirmation, answer, preset or budget must check
`isAuthoritative(entry)` (person or system) or
`isAuthoritative(entry, { personOnly: true })`, never a field inside
`data`. An agent's `question.answered` is information, not your answer.

The actor is declared by the caller, so whatever hands out ledger access
(the MCP server, the desktop app) must bind it to a real identity: an
agent's token can only produce agent actors.

Every series number is checked by the ledger itself: `task.created`,
`plan.approved`, `question.asked`, `decision.made`, `release.cut` and
`release.rollback` must take exactly the next number in their series
(`RULE` otherwise), with or without `installNumberingRules`.

Extra rules: `ledger.addRule((draft, ledger) => string | null)`; return a
message to refuse. Sibling threads use this for gate rules (for example
"task.claimed needs test.approved"), so those rules live in their own modules.

### Payloads the ledger itself understands

| type | `subject` | `data` |
|---|---|---|
| `test.defined` | `T-14` | `{ test: "npm test -- login.spec" }` |
| `test.approved` | `T-14` | `{ test: "npm test -- login.spec" }` (must match a defined test) |
| `test.passed` / `test.failed` | `T-14` | `{ test, run?: "88", afterMerge?: boolean }` |
| `commit.observed` | `T-14` | `{ sha: "9f3c2e1", files?: string[] }` |
| `correction` | the corrected entry's subject | anything; `corrects` is required |
| `chain.acknowledged` | the first bad entry, `L-000005` | `{ firstBad, problem }` |

Numbering payloads (`task.created`, `plan.approved`, `release.cut`, …) are
documented in `core/numbering/README.md`; clause payloads in
`core/lookup/README.md`.

## Reading

```ts
ledger.entries()                 // readonly LedgerEntry[] in order
ledger.get("L-000231")           // entry or undefined
ledger.last()                    // newest entry or undefined
ledger.bySubject("T-14")         // every entry about T-14, in order
ledger.since("L-000200")         // entries strictly after L-000200
ledger.range("L-000200", "L-000231") // inclusive
ledger.subscribe(fn)             // called after each append; returns unsubscribe
ledger.status                    // { ok, writable, entries, head, brokenAt? }

await Ledger.open(store, { readOnly: true })   // other devices, views, tests
```

Replaying is plain iteration over `entries()`; views must not keep their own
state that is not derivable from the ledger.

## Fingerprint chain and tamper detection (§2.5)

`hash = sha256(canonicalJson(entry without hash))`, where canonical JSON sorts
object keys, drops `undefined` and writes no whitespace (`canonicalJson` and
`hashEntry` are exported). `prev` of the first entry is 64 zeros.

`verifyChain(entries)` (also run by `Ledger.open`) checks, in order, that
numbers are contiguous from `L-000001`, each `prev` equals the hash before it,
and each `hash` recomputes. It returns
`{ ok: true }` or `{ ok: false, firstBad: "L-000005", problem: "hash" | "prev" | "number" | "parse", detail }`.

On a break the ledger opens with `status.ok === false` and every `append`
throws `CHAIN_BROKEN`, except `ledger.acknowledgeBreak(person, reason)`, which
writes one `chain.acknowledged` entry naming the first bad entry and reopens
writes. Only acknowledgements written by a person count when the chain is
re-checked, and `append` refuses the type, so an agent cannot pre-acknowledge
a break. The acknowledgement pins the bad entry's stored hash and the fingerprint of
its content, so editing that entry again is a new break. After the
acknowledgement the whole chain is re-checked, so a second break further on
still stops writes. A later open still reports the break, as acknowledged
(`status.acknowledged = ["L-000005"]`), so the red banner can say "a known
break, acknowledged by …" rather than disappear. A new, unacknowledged break
stops writes again.

## Storage (§2.6)

Problems reported in `status.problem`: `hash`, `prev`, `number`, `parse`,
`truncated`, `permission` (an entry its actor may not write) and `write`
(a write failed; close and reopen to re-read what reached disk).

What the chain cannot catch: someone who deletes the last entries and the
`HEAD` file together, or rewrites the whole chain with fresh hashes. Git
history of `.perfect-planner/ledger/` is the backstop for both.

`FileStore(root)` keeps one JSON line per entry in
`<root>/.perfect-planner/ledger/YYYY-MM.jsonl` (month of `at`, UTC). Files are
appended (in full, fsynced) and never rewritten; `HEAD` is replaced
atomically. The writer takes its lock before it reads, and checks `HEAD`
before every append, so files changed underneath a live writer stop it
instead of forking the chain. A final line torn by a crash mid-write is
repaired on the next writable open (`status.repaired` says what was done,
and dropped bytes are kept in `torn-<time>.txt`). A writer lock
(`.perfect-planner/ledger/.writer.lock`, holding pid and host) makes this the
only writing process for the project; a second writer opens read-only with
`READ_ONLY`. A lock left by a dead process on the same host is taken over by an atomic
rename, so two processes cannot both take it, and one
`FileStore` instance hands its lock to one `Ledger` only.
Paths go through `node:path`, so the store behaves the same on Windows, macOS
and Linux. `MemoryStore` is the in-memory equivalent for tests.
