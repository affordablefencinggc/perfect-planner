# core/watcher — the git watcher

Spec 4.4: the ledger never depends on agents behaving. Every few seconds the
watcher reads each task worktree's changed files and new commits and writes
the git facts into the ledger itself. It also reports stalled tasks.

## API

```ts
import { GitWatcher } from "../watcher/index";

const watcher = new GitWatcher({
  ledger,                         // LedgerPort (core/worktrees/ports)
  worktrees: () => manager.list(),// WorktreeInfo[] or a promise of one
  stallMs: 15 * 60_000,           // optional, default 15 minutes
  now: () => Date.now(),          // optional clock, for tests
  onError: (e) => log(e),         // optional, only for start()
});
const result = await watcher.tick();
watcher.start(3000);              // unref'd timer, ticks never overlap
await watcher.stop();             // waits for a tick in flight
```

`tick()` returns `{ observed, collisions, resolved, stalled, active, errors }`:
the commits and collisions written this tick, every stalled task, every open
collision, and any worktree that could not be read (missing folder, bad base,
git error) or ledger write that failed. Errors never stop the tick; failed
work is retried on the next one.

Building blocks, all exported from `index.ts`:

- `changedFiles(path, baseSha)`: committed changes since the base plus staged,
  unstaged and untracked files. Renames count both names. Repo-relative,
  forward slashes, sorted, de-duplicated. `.perfect-planner/` is ignored.
- `commitsSince(path, baseSha)`: first-parent commits since the base, oldest
  first, as `{ sha, author, at, subject, refs, taskIds }`.
- `parseImplements(body)`: reads `Implements: P-2 §3.1 (T-14)` trailers. Several
  lines, comma or semicolon separated clauses, `P-2 §3.1, §3.2` shorthand, LF
  or CRLF.
- `findCollisions(changes)`: pure; every pair of tasks that changed the same
  file. Files compare through `normalizeSurface("file", …)` from the collision
  engine, so case-only differences collide (on every OS).

## Ledger entries it writes

All with actor `WATCHER_ACTOR` (`{ kind: "system", id: "watcher" }`).

| type | subject | evidence | other |
|---|---|---|---|
| `commit.observed` | `T-14` | `commit:<sha>`, `branch:pp/T-14`, `author:…`, `at:…`, `file:…` | `refs` from `Implements:` trailers; `data: { sha, files }` |
| `collision.detected` | `T-1+T-2` | `task:T-1`, `task:T-2`, `file:…` | written once per pair and file set |
| `collision.resolved` | `T-1+T-2` | same as the detection | when the pair no longer shares a file, or a task's worktree left the list |

At most 200 `file:` items are written per entry, then `files-omitted:<n>`.

Dedupe survives a restart: on the first tick the watcher replays
`ledger.entries()` to learn which (task, sha) pairs were already observed and
which collisions are open. If the ledger cannot be read, the tick writes
nothing.

A collision whose task could not be read this tick stays open; one whose task
has no worktree any more is resolved.

## Stalls

A task is stalled when its newest commit, its changed-file set and the newest
mtime among its changed files have not moved for `stallMs`. Stalls are
reported in the tick result only; nothing is written. The idle clock starts
when the watcher first sees a task, so it resets on restart.
