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
  sig?: { key: string; value: string; pub: string };  // person and system entries: Ed25519 signature, key id, public key
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
| Housekeeping | `correction`, `budget.warning`, `chain.acknowledged`, `key.trusted`, `key.retired`, `owner.recovery.set`, `owner.recovered` |

`chain.acknowledged` is how a person clears a fingerprint break (§2.5).
`key.trusted` and `key.retired` are how a person trusts and retires signing keys (see "Signatures"). `owner.recovery.set` and `owner.recovered` are the owner's recovery code and its use ("Lost owner key").

## Writing

```ts
import { Ledger, FileStore, MemoryStore } from "../ledger/index";

const keys = new KeychainKeyProvider();   // OS keychain; the app process only, never an agent
const ledger = await Ledger.open(new FileStore(projectRoot), { keys });   // takes the writer lock
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
| `NOT_SIGNED` | a person or system entry, and this device cannot sign it: no key provider, the keychain is unavailable (the message says why), or no key for that person here. Nothing is stored unsigned |
| `READ_ONLY` | the ledger was opened read-only, or another process holds the writer lock |
| `RULE` | a rule registered with `ledger.addRule` refused it; also `test.approved` for a command never defined for that task, and `chain.acknowledged` written through `append` (use `acknowledgeBreak`) |

### Who may write what

Checked before every other rule, from `DEFAULT_PERMISSIONS` (or
`Ledger.open(store, { permissions })`):

| Actor kind | May write |
|---|---|
| `person` | any type (`core/people` narrows this per role: owner, helper, viewer) |
| `system` (the gate, the git watcher) | any type except `chain.acknowledged`, `key.trusted`, `key.retired` and the `owner.*` types |
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
`isAuthoritative` is true only for entry objects handed out by a `Ledger`
whose signature checked out against a trusted key; a copy, a re-parsed
line or a hand-built entry is never authoritative.

The actor is declared by the caller, but person and system entries are
signed (next section), so a caller can only produce them through the app
process that holds the keys. Whatever hands out ledger access to agents
(the MCP server) must never pass them a key provider.

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
| `owner.recovery.set` | the recovery key id | `{ genesis, recoveryKeyId, recoveryPublicKey }` (setRecoveryCode only) |
| `owner.recovered` | the new owner key id | `{ genesis, head: { n, hash }, newKeyId, newPublicKey, recoveryKeyId, recoverySignature }` (recoverOwner only) |

Numbering payloads (`task.created`, `plan.approved`, `release.cut`, …) are
documented in `core/numbering/README.md`; clause payloads in
`core/lookup/README.md`.

## Signatures

Every `person` and `system` entry carries `sig`, an Ed25519 signature over
every field except `hash` and `sig` (so `n`, `at` and `prev` are signed),
and `hash` covers `sig`. Agent and Jev entries are not signed and are never
authoritative. Each person has their own key, principal `person:<actor id>`;
the gate and the watcher share the app's key, principal `system`.

- `Ledger.open(store, { keys })` takes a `KeyProvider`: `state()`,
  `trustedKeys()`, `sign(principal, bytes)`. The private key never leaves
  the provider.
- `KeychainKeyProvider` keeps keys in the OS keychain: Windows Credential
  Locker, the macOS keychain, the Linux Secret Service (`secret-tool`).
  Secrets go to those tools on stdin, never on a command line, in a file or
  in a log. `ensureKey(principal)` makes a key; call it on the person's own
  action (setup in Settings), never from an agent. Signing never creates one.
- When the keychain is unavailable, `state()` says why in plain words and
  person and system writes fail with `NOT_SIGNED`. Nothing is written
  unsigned.
- `MemoryKeyProvider` is the test fake. `MemoryStore` brings one, so
  in-memory ledgers need no setup. A `FileStore` ledger without `keys`
  refuses person and system writes, and reports every signed entry as
  unchecked (`signature`).

Checking on open (and after every write that changes trust): an entry
with no signature, an unknown key, another principal's key or a bad
signature is a `signature` break. Writes stop, as with any break. A person
may acknowledge the break to resume work. The entry stays non-authoritative
either way.

Every signature records its public key (`sig.pub`, which must hash to
`sig.key`), so the ledger keeps every key that ever signed it.
`recordedKeys(entries)` lists them. Recording a key is not trusting it.

Trusted keys come from two places:

- **The device.** The provider's own keys, and keys pinned on this device
  only (`pin` / `pinKey`) after the person checked the fingerprint. For
  example, a helper's device pins the owner's key.
- **The ledger.** Keys added by `key.trusted` entries,
  `data: { keyId, principal, publicKey }`, reason required.
  `ledger.trustKey(person, key, reason)` writes one. It is allowed while the
  only problem is signatures this device cannot check. A key trusted late in
  the ledger also covers what it signed earlier.

Who may trust a key for a principal: that same person (a new device, a
rotation, recovery), or the owner (only with `ownerKey`, below). A key the ledger already shows signing
for one person cannot be trusted as another's.

**The owner** exists only when the app names it.

- At project creation, the app makes the owner's key (`ensureKey`) and keeps
  that key id outside the ledger, in project settings or the keychain.
- On every open it passes the id: `Ledger.open(store, { keys, ownerKey })`.
- The ledger's first person entry must be signed by exactly that key, and
  the key must be trusted on this device. Otherwise it is a `signature`
  break on open, and `NOT_PERMITTED` when writing.
- Then `ledger.owner` and `status.owner` name the owner.
  `ledger.ownerKeyPinned` and `ledger.pinnedOwnerKey` say whether a key was
  passed, whether or not it checked out.

Without `ownerKey` there is no owner, whoever wrote first. Each person can
still trust and retire their own keys, but nobody can trust or retire
another person's.

**Rotation and stolen keys.** Call `ledger.rotateKey(person, reason)`. It
works with any provider that can stage keys (`stageKey`, `activateKey`), and
both built-in providers can:

1. The provider stages a new key, which does not sign yet.
2. The old key vouches for it in a `key.trusted` entry.
3. The new key becomes active.
4. The new key retires the old one in a `key.retired` entry.
5. Every other key of the person still in force is retired too, unless it
   is listed in `rotateKey(person, reason, { keep })`. A device key that a
   thief added with the stolen key must not outlive the rotation.
   `status.ownKeysRetired` tells a dropped device that it can no longer
   sign.

Every device that trusted the old key replays those two entries, so it
trusts the new key from step 2. It also refuses anything the old key signs
after step 4.

`ledger.retireKey` refuses to sign with a key the ledger does not record
yet: no other device could know that key, so they would ignore the
retirement. After a rotation, use `rotateKey`. The owner can retire a
helper's key the same way, for example when they leave.

Key trust is replayed in ledger order a fixed number of times:

1. A plain replay.
2. A replay in which keys a person re-trusted count from the start.
3. A final check.

So the answer never depends on the ledger's length. A retirement is final:
no later entry can bring a key back.

**Lost keychain** (reinstall, new PC). Make a new key. The ledger then shows
the old entries as signed by a key this device does not trust. The app shows
the old key's fingerprint from `recordedKeys`. Once the person confirms it
was theirs, `trustKey` restores it, signed by their new key. Everything the
old key signed counts again, including enrolments the owner made.

Without that confirmation, the old entries stay unchecked: shown, but not
authoritative. A helper who lost their key needs the owner to re-enrol
them, or a second device of their own.

**Lost owner key: the recovery code** (`recovery.ts`, design in
`specs/owner-key-recovery.md`). The fix above needs the app's owner-key pin,
which goes with the keychain. So the owner gets a one-time code instead:

- `setRecoveryCode(owner, reason)` makes a 128-bit code (28 characters;
  the last two catch any one wrong character or swapped pair) and returns it once, for the app to show.
  Only a public key derived from it is written, in `owner.recovery.set`,
  signed by an owner key in force. A new code replaces the old one.
  The derivation is HKDF-SHA256, salted with the project's root: the hash
  of the ledger's first person entry and the key that signed it. So a code
  fits one project only, and not a ledger rewritten under another key
  from that point.
- Owner keys follow the ledger (`ownerChain`). The first person entry's
  key starts it. An owner key in force can add one (a rotation or a
  second device) or retire one. Only the latest code set by a key in force
  counts.
- On a new computer, `checkRecoveryCode(code)` shows the owner and the
  ledger's head. The code proves where the history starts, not that its
  end is all there, so the person confirms the head first.
- `recoverOwner(owner, code, confirmedHead, reason)` writes
  `owner.recovered`. It is signed by this computer's key, which countersigns
  the entry, and it carries the code key's signature over the project, the
  confirmed head and both key ids. That key becomes the owner key, and the
  app must pin `ownerKey` to it (the pin lives in app data, keyed by the
  ledger's genesis hash). Every owner key in force stops signing at that
  entry. The code is spent, and a new one is returned. Before spending the
  code, the whole ledger is checked as the owner's keys would see it. A
  problem the recovery would not fix stops it, and the code stays unused:
  a damaged file, or an owner entry the owner's keys do not verify.
  Entries signed by keys only the old computer knew are accepted as
  unverified, for example the gate, the watcher or helpers.
  `recoverOwner` returns their numbers in `unverified`. The owner then
  checks those keys' fingerprints and trusts them with `trustKey`.
- A computer still pinned to the old key opens with `status.ownerKeyReplaced`
  set and can no longer sign as the owner. The app shows a red "recovered on
  another computer" notice. If that was not the person, the old computer's
  copy can only be kept read-only and forked.
- `owner.*` entries are written only by these methods, never by `append`.
  The methods belong on the person's own app session, never on an agent or
  MCP route.
- The code must never reach the clipboard, a log, telemetry or an
  evidence screenshot. Recovery screens live under `OWNER_RECOVERY_PATH`
  (`/owner-recovery`), which evidence capture refuses to screenshot.

**Another device or a helper.** A second device of the same person is
trusted by that person. A helper is enrolled by the owner. Each device also
pins the keys it needs to read the others, after the fingerprint is checked.

**What this does not stop:**

- A process running as the same OS user that calls the keychain tools
  itself. On Windows and Linux, any such process can read the Credential
  Locker or an unlocked Secret Service. On macOS, items made with
  `security` are readable by `security`.
- So agents must run without access to the user's keychain: a separate
  OS user, a sandbox, or a container. That is the gate's job.
- Requiring Windows Hello, Touch ID or a polkit prompt per signature is the
  next step.
- A thief who uses a stolen key before it is retired: those entries count.
  Retire it as soon as the loss is known.
- If the thief retires the person's new key first, the owner has to re-enrol
  them.
- A same-user process can read the recovery code while it is shown or
  typed, and whoever holds the code can take over the project.
- Recovery cannot detect a tail cut from the ledger before the new
  computer reads it. The person's check of the head is the only guard
  there. On a computer that keeps its app data, the `witness` open option
  (`FileHeadWitness`, a copy of the head in the app's data folder) shows a
  cut tail or a rewritten last entry, even when HEAD was changed to match.
  Each copy of a project folder has its own copy of the head. An unreadable
  copy is reported in `status.witnessProblem` and never overwritten.
  A same-user process can edit that copy too.
- Anyone with write access to the files can append entries signed with
  keys nobody trusts. That stops writes until a person acknowledges the
  break. It is a nuisance, not a forgery: those entries never count.

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
its content (and, for a `prev` break, the entry before it, which is the one
that was rewritten), so editing either again is a new break. Acknowledging
also rewrites a missing or stale `HEAD` from the current tip. After the
acknowledgement the whole chain is re-checked, so a second break further on
still stops writes. A later open still reports the break, as acknowledged
(`status.acknowledged = ["L-000005"]`), so the red banner can say "a known
break, acknowledged by …" rather than disappear. A new, unacknowledged break
stops writes again.

## Storage (§2.6)

Problems reported in `status.problem`: `hash`, `prev`, `number`, `parse`,
`truncated`, `permission` (an entry its actor may not write), `signature`
(a person or system entry whose signature does not check out) and `write`
(a write failed; close and reopen to re-read what reached disk).

What the chain cannot catch: someone who deletes the last entries and the
`HEAD` file together. A rewrite of the whole chain with fresh hashes can no
longer produce person or system entries, but it can still drop them from
the end, or change agent entries. Git history of `.perfect-planner/ledger/`
is the backstop for both.

`FileStore(root)` keeps one JSON line per entry in
`<root>/.perfect-planner/ledger/YYYY-MM.jsonl` (month of `at`, UTC). Files are
appended (in full, fsynced) and never rewritten; `HEAD` is replaced
atomically. The writer takes its lock before it reads, and checks `HEAD`
before every append, so files changed underneath a live writer stop it
instead of forking the chain. A final line torn by a crash mid-write is
repaired on the next writable open: `status.repaired` says what was done,
dropped bytes are kept in `torn-<time>.txt`, and a system `correction`
entry records the repair in the ledger itself. Known gap: three processes
racing for a stale lock in one narrow window can both believe they hold it. A writer lock
(`.perfect-planner/ledger/.writer.lock`, holding pid and host) makes this the
only writing process for the project; a second writer opens read-only with
`READ_ONLY`. A lock left by a dead process on the same host is taken over by an atomic
rename, so two processes cannot both take it, and one
`FileStore` instance hands its lock to one `Ledger` only.
Paths go through `node:path`, so the store behaves the same on Windows, macOS
and Linux. `MemoryStore` is the in-memory equivalent for tests.
