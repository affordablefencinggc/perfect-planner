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
   check one branch out in two worktrees. The whole `.perfect-planner/` folder (worktrees, the ledger,
   worker tokens) is added to `.git/info/exclude` (`REQUIRED_IGNORES`, `ensureRequiredIgnores`), so
   `git add -A` never stages it and the main checkout stays clean without editing the tracked `.gitignore`.
4. Picks a free dev-server port (default 5200 to 5999) that no other worktree holds and nothing is listening on.
5. Copies untracked `.env*` files from the main checkout with every value replaced by `PLACEHOLDER`, except plainly
   safe settings (ports, hosts, modes, flags) whose values don't themselves look secret. Connection strings with
   credentials, long random strings and anything unrecognised become placeholders.
6. Installs the commit-time secret scan (`hooks/secret-scan.mjs`) for this worktree only, through
   `core.hooksPath` in per-worktree config, so the user's own hooks in the main checkout are untouched.
7. Installs dependencies (`npm ci --prefer-offline` when there is a `package-lock.json`, using the shared npm cache).
8. Records the worktree and writes `worktree.created` to the ledger.

If any step after `git worktree add` fails, the fresh worktree and branch are rolled back.

## Removal never discards work

`manager.remove("T-14")` refuses while the worktree has uncommitted or untracked files, or ignored
files that hold work (anything but `node_modules` and `.env*` files still exactly as launch copied them),
because `git worktree remove` deletes ignored files too. It deletes the branch only when it is fully
merged into its base, otherwise keeps it and says so. Writes `worktree.removed`.

## Changes to the user's repository config

The first launch turns on git's `extensions.worktreeConfig` (and, if needed, sets
`core.repositoryformatversion` to 1) in the repository's own config, so the secret-scan hook can be
set per worktree without touching the user's hooks. It stays on afterwards; git 2.20+ understands it.
Turn it off with `git config --unset extensions.worktreeConfig` once no task worktrees remain.
Pass `secretScan: false` to skip the hook and leave the config alone.

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

## Starting git safely

Every git the core starts goes through `runGit`, which runs `gitExecutable(cwd)`: an absolute path
resolved once from PATH (again only if PATH changes), skipping empty, relative and network entries and
any entry inside the repo, and refused if it sits inside `cwd`. On Windows `spawn("git")` with the
user's repo as `cwd` would otherwise run a `git.exe` planted in that repo, because CreateProcess looks in
the current folder before PATH. Every child also gets `NO_CWD_SEARCH_ENV`
(`NoDefaultCurrentDirectoryInExePath=1`), so cmd.exe and nested programs skip the current folder too.
Other modules that spawn git (the ledger's ignore check, release hooks) should import
`gitExecutable` and `NO_CWD_SEARCH_ENV` from `core/exec` (re-exported by `core/worktrees`), or call `runGit`, rather than spawning
a bare `git`.

npm is never started by name or through a shell. `runNpm` runs `node npm-cli.js` with the Node that
runs Perfect Planner, taking npm's entry script from beside that Node or from an npm on PATH found by
core/exec, and refusing any copy inside the project, its repo or its worktrees (`protect` roots,
compared as written and as real paths). Installs pass `--ignore-scripts` unless a person turned on
`allowInstallScripts` (WorktreeManager and TestGate options), since a dependency's install script is
arbitrary code. The project's own `.npmrc` is agent-controlled, so every setting that names a program is
fixed on npm's command line, which outranks all config files: `--git` is core/exec's git and
`--script-shell` the system shell, user and global config come from empty files, and inherited
`npm_config_*` variables are dropped. A failed install with scripts skipped names the switch.

`runGit` is the one runner for every host git call (#25 and #13 use it too). The project's own `.git`
is writable by any program on the PC, so it never lets git run what the repo config or hooks name:
`core.hooksPath` points at an empty app-owned folder (pass `hooksPath` to use the app's own hooks),
`core.fsmonitor=false`, `diff.external=` and an empty `core.attributesFile` are fixed on the command
line, diffs get `--no-ext-diff --no-textconv`, and display settings that would change the diff a
person reviews (`diff.relative`, `diff.noprefix`, colour, order file) are reset. System and global
config are replaced by an app-owned file holding only the user's identity, `safe.directory` and
line-ending settings (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_ATTR_NOSYSTEM`), and
inherited `GIT_CONFIG_*`, `GIT_EXEC_PATH`, `GIT_EXTERNAL_DIFF` and similar are dropped. Any command
outside a short allow-list (rev-parse, show-ref, ls-tree, merge-base, update-ref, config, plain
cat-file, worktree list/remove/prune and similar) is refused (`GitProgramRefusedError`) while the repo
config names a filter program or merge driver (`filterPrograms`): a person must review and remove it.
