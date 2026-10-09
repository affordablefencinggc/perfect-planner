# core/worktrees — one worktree per task

Spec §5.3 and §5.6. Every task runs in its own git worktree so parallel agents never
share a checkout. Owner: the "worktrees and test-first gate" thread. Also home of the
small platform layer (`platform.ts`, `git.ts`) that `core/watcher` and `core/gate` use.

## What launch does

`manager.create({ taskId: "T-14", actor })`:

1. Checks the id (`T-14`, or `T-14.a2` for a retry), the parallel cap (default 4) and that
   no other running task has claimed the same files.
2. Refuses if branch `pp/T-14` already exists. Retries get a new attempt id instead of reusing a branch.
3. `git worktree add -b pp/T-14 .perfect-planner/worktrees/T-14 <base sha>`. Git itself refuses to
   check one branch out in two worktrees. The folder is added to `.git/info/exclude`, so the main
   checkout stays clean without editing the tracked `.gitignore`.
4. Picks a free dev-server port (default 5200 to 5999) that no other worktree holds and nothing is listening on.
5. Copies untracked `.env*` files from the main checkout with every secret-looking value replaced by `PLACEHOLDER`.
6. Installs the commit-time secret scan (`hooks/secret-scan.mjs`) for this worktree only, through
   `core.hooksPath` in per-worktree config, so the user's own hooks in the main checkout are untouched.
7. Installs dependencies (`npm ci --prefer-offline` when there is a `package-lock.json`, using the shared npm cache).
8. Records the worktree and writes `worktree.created` to the ledger.

If any step after `git worktree add` fails, the fresh worktree and branch are rolled back.

## Removal never discards work

`manager.remove("T-14")` refuses while the worktree has uncommitted or untracked files. It deletes
the branch only when it is fully merged into its base, otherwise keeps it and says so. Writes `worktree.removed`.

## Other calls

| Call | Does |
|---|---|
| `list()`, `get(taskId)` | Running worktrees (`WorktreeInfo`: branch, path, baseSha, baseRef, port, claims) |
| `claim(taskId, files)` | Adds file claims; returns conflicts (folder and case aware, same rules as the collision engine) |
| `reconcile()` | Compares the registry with `git worktree list`: entries git lost, and pp worktrees nobody tracks |

State lives in `<git common dir>/perfect-planner/worktrees.json`, so it survives restarts and is shared by every worktree.

## Ledger entries written

| type | subject | data |
|---|---|---|
| `worktree.created` | `T-14` | `{ branch, baseRef, baseSha, port, path, claims }` |
| `worktree.removed` | `T-14` | `{ branch, branchDeleted }` |

## Platforms

Windows, macOS and Linux. Git runs without a shell; output is split on LF or CRLF; paths are
stored with forward slashes and compared case-insensitively on Windows and macOS; temp and
worktree paths are resolved with `realpath` so 8.3 names and `/var` → `/private/var` don't
create false mismatches; the registry write retries the atomic rename when Windows briefly locks the file.
