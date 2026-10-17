# Project isolation: what holds, what does not, and the plan for a real sandbox

Perfect Planner can hold several projects at once (one ledger, one set of tokens, one bridge each, all in one
host process). Today the only things that keep one project's work out of another are logic: a ledger per
project, an owner pin, tokens that name one task, worktrees, a restricted PATH and placeholder secrets. There is
no operating-system sandbox. This file says, one item at a time, which of those logic checks hold up when
attacked (each has a test that tries the attack and asserts the safe outcome), which do not (each has an
`it.fails` test named "known gap", so the gap is written down in code and the suite goes red the day it is
closed by accident), and what the opt-in sandbox in step B has to be.

How to read the tests: `isolation.test.ts` and `isolation-exec.test.ts` are in `core/host/`. Both run two real
projects ("alpha", "beta") in one host with real git repos, real tokens and a real bridge, and a fake key store.
Nothing calls Jev or a model. Windows and macOS were not run (see the end of "Not enforced"); the Windows
spellings are checked as strings on Linux.

## Enforced

Every line names the test (file, then the start of its title) that attacks it. All of these pass today.

**Tokens**

- A worker token from project A is refused by B's bridge on every tool, and B's by A's; a connect token from A
  cannot become B's main chat. `isolation.test.ts`: "a worker token from A is refused by B's bridge on every
  tool", "a connect token from A cannot become B's main chat".
- A worker sees only its own project's board and its token cannot name another task (`FORBIDDEN`).
  "a worker sees only its own project's board".
- A worker token is not a login: as a bearer token, a cookie or a CSRF value it gets 401 on reads and writes of
  both projects. "a worker token is not a login".
- No app route hands back a token, a token file's content or another project's folder, for either project, even
  to the person's own window. "the person's window works on both projects, but no route hands back a token".
- Task ids in the URL (`..`, `%2e%2e`, encoded slashes and backslashes, an unknown id) cannot place a token file, brief or worktree
  outside the project. "task ids from the URL cannot name a path".

**The same task id (T-1) in two projects**

- Approving A's T-1 test moves nothing in B: B's T-1 stays unapproved and B's worker cannot claim it.
  "approving A's T-1 test moves nothing in B".
- A request made for A and replayed against B without the person's window (no cookie, no CSRF header) is refused
  with 401 on approve-test, approve-diff, merge, reject and release, and writes nothing. "a request meant for A,
  replayed against B without the person's window, writes nothing".

**Project names and folders**

- No odd name reaches another project or a folder outside the app's data folder: `..`, `../beta`, `..%2Fbeta`,
  `%2e%2e`, `beta/../alpha`, slashes, backslashes, `.`, `beta.`, `beta..`, Windows device names (`con`, `NUL`,
  `aux.txt`, `com1`, `lpt9`), spaces, non-ASCII, 65 characters, a leading `-` or `_`, a NUL byte. Each gets
  400 `INVALID_PROJECT` and creates nothing. "no odd project name reaches another project or a folder outside
  the app's data folder". (Before this lane an invalid name silently became the `default` project.)
- The `default` project is used only when no name, or an empty one, is given. Spaces around a real name are
  trimmed, not a new project. "no name, or an empty one, is the 'default' project".
- Names that differ only in case, in trailing dots or spaces, or in accent composition are one folder where the
  OS says so (Windows, macOS) and are refused as the same folder; on Linux they are two projects. Checked as a
  matrix for all three OSes. "names that differ only in case are two projects on Linux and refused as one folder
  where the OS ignores case".
- A project folder that is a symlink (or junction) to another project's folder is refused with 409
  `FOLDER_IN_USE`, whichever is opened first. "a project folder that is a link to another project's folder".
- `PP_CORE_PROJECT_ROOT` (dev and tests) gives every name one folder; the second name is refused and the first
  keeps writing. "PP_CORE_PROJECT_ROOT gives every name one folder".
- A second host (a second copy of the app) on the same data folder opens every project read-only and its writes
  are refused, so two writers never append to one ledger. "a second host on the same data folder opens every
  project read-only".
- The MVP scan folder cannot be aimed at another project: not with `..`, an absolute path, a backslash path or a
  link (`BAD_PATH`). "the MVP scan folder cannot be aimed at another project".

**One git folder, one project** (new in this lane: `repoClaim.ts`)

Worktrees, the `pp/T-n` branches, the port table and the worktree registry belong to the git folder, not the
project. Before this lane two projects given the same repo shared T-1: B's dispatch found A's worktree and handed
its worker A's checkout. Now the first project to use a git folder writes a record in the repo's own git folder
and another project is refused (409 `REPO_IN_USE`) in choosing it, in dispatching on it and in reading it.
All in "a git folder is used by one project":

- the same git folder cannot be given to a second project, and the first project's worktree is untouched;
- a folder an older app already filled with A's worktrees (a registry, no record) is not handed to B;
- when A moves to another git folder, B may take the old one over, but when A is gone and its worktrees are not,
  B may not (work started elsewhere is named and kept, never adopted);
- a damaged record is not guessed around (the one file to move aside is named);
- a symlink planted where the next worktree goes is refused, and nothing lands in the other project's repo;
- two projects choosing the same unused git folder at the same moment: exactly one gets it;
- another spelling of A's git folder (a worktree of it, a link to it, a path with dots) is still A's folder;
- a git folder written as a network path, another drive's path, a URL or a home shortcut is refused and nothing
  is recorded; a network path saved in a project's own repo.json is never looked at on Windows (UNC, device and
  mixed-slash spellings). Checked as strings.

**Ledgers, owner pins and files on disk**

- A's signed entries pasted into B's ledger file break B's chain: B reports the damage (`ledgerIntegrity`
  damaged, `writesStopped`), cannot be written, and a worker cannot claim; nothing is claimed, approved or merged
  on A's approval. "project A's signed entries pasted into project B's ledger file break B's chain".
- A's owner pin copied over B's is not trusted: B reports it as `tampered` and opens without an owner.
  "project A's owner pin copied over B's is not trusted".
- A's ledger copied over B's folder is noticed: B is `replaced`, not fresh or trusted. "project A's ledger copied
  over B's folder is noticed".

**Environment and placeholder secrets**

- A command run by the gate sees none of the host's secrets (API keys, cloud and git tokens, `SSH_*`, `PP_*`
  bridge variables) and what the caller hands one run is in that run only, not in the next project's.
  `isolation-exec.test.ts`: "holds none of the host's secrets, and a variable given to project A's run is not in
  project B's run"; "the test sees none of the host's secrets in its environment" (a hostile test run for real
  through approve-test).
- A worktree gets placeholders for `.env*`, never the real value, and no project's value shows up in the other
  project's worktree, ledger or token files. "a worktree gets placeholders, never the real value" and "the
  worktree's own .env holds placeholders".

## Not enforced

Each of these is a test written as `it.fails` (it passes today because the safe outcome does not happen). When
a fix lands the test starts passing, the suite fails, and the fixer deletes `.fails` and moves the item up.

**Logic gaps (fixable without a sandbox; owners named)**

1. **A person's approve-test request made for A, replayed with `project=beta`, approves B's own test.** The
   request is bound to the ledger number of the test definition the person read (`{ test: "L-000003" }`), and
   two projects that did the same steps have the same numbers. The person's cookie and CSRF header work for
   every project, so nothing says "this is for A". Repro: `isolation.test.ts`, "known gap: a person's
   approve-test request made for A, replayed with project=beta". Needs a decision from L1 (owns approve-test in
   wave 1): bind the request to the definition's hash or to the project. Not changed here.
2. **Readers count a signed approval pasted in from another project's ledger.** The ledger deliberately marks an
   entry verified when its signature holds, "whatever else is wrong: authority is per entry", and the same
   device key signs for every project. Nothing in the signed bytes names the ledger. The broken chain stops
   every write (enforced, above), but `gate.state` and the Tasks screen still show the pasted approval. Repro:
   "known gap: readers do not count a signed approval pasted in from another project's ledger". Needs an owner
   decision in core/ledger or core/gate (both safety-checked: reported, not changed): sign the project key into
   the entry, or have readers ignore entries from a chain that is broken.
3. **Two projects' workers are given the same dev-server port.** Ports (5200 to 5999) are chosen per git folder,
   so alpha's first worker and beta's first worker both get 5200; whichever server starts second cannot have
   it, and a worker reaching for "its" port can reach the other project's server. Repro: "known gap: two
   projects' workers are given different dev-server ports". Fix needs a host-wide port table in the app's data
   folder, which touches core/worktrees: left for step B.

**Gaps only a sandbox closes (step B).** Test commands (and the workers) run as the signed-in user with the
user's file access. `isolation-exec.test.ts` commits a hostile test in A's worktree, proposes it, and lets the
gate run it through approve-test; the test prints what it managed to do. Today, in one run, it:

4. read the project's real `.env` in the main checkout (`../../../.env`): NOT blocked;
5. read project B's worker token file: NOT blocked;
6. read project B's ledger in the app's data folder: NOT blocked;
7. read a stand-in `~/.ssh/id_fake` in the home folder: NOT blocked;
8. wrote a file outside the worktree: NOT blocked;
9. wrote a file into its own project's main checkout, skipping the diff review: NOT blocked;
10. wrote a file into project B's git folder: NOT blocked;
11. opened a connection to a loopback port (any host service, including another project's bridge, whose token it
    could just have read in item 5): NOT blocked;
12. ran as the same OS user as the host (uid equal): NOT blocked (skipped on Windows);
13. left a detached process running after the check ended: NOT stopped (only a timeout kills the tree; skipped on
    Windows).

Tests: the ten `it.fails("known gap: ...")` cases in the "not enforced" block. What is enforced for these
today is only the environment (secrets scrubbed), the PATH (planted-program refusal) and placeholders in the
worktree's `.env`. `../` of the worktree and the app data folder are not protected. Because of items 5 and 11 a
hostile test can read a token and call a bridge, so "tokens keep projects apart" holds against the proper
channels (the checks above) and not against a test command that goes looking on disk.

**Other limits, said plainly**

- One person means one set of credentials: the person's cookie, CSRF header and signing key work for every
  project, by design. Nothing separates two projects from the person's own window, only from workers.
- The host is one process. A bug in it that mixes two projects' objects is not caught by any test here beyond
  the routes attacked above.
- Not run: any Windows run (UNC, junction, case and trailing-dot rules are string checks on Linux; real NTFS
  8.3 short names, reparse points and `\\?\` handling are NOT RUN), any macOS run, and CI.
- The merge candidate's clean install can run package install scripts when a person turns that on
  (`allowInstallScripts`); those would also run uncontained. Off by default; not attacked here.

## Design for step B: an opt-in local sandbox

Design only. Nothing in this section is built.

**Goal.** A test command, and later a worker, can read only its worktree and the read-only toolchain, can write
only its worktree (and a private scratch folder), and has no network unless a person allows it. Items 4 to 13
above turn into passing tests; each `it.fails` is flipped to `it`.

**Where it plugs in, without touching core/gate.** `TestGate` already takes `run?: TestRunner`, where

```ts
type TestRunner = (command: string, cwd: string, options: TestRunOptions) => Promise<TestRunResult>;
```

and `TestRunOptions` already carries `env`, `protect` (the folders to keep programs out of) and `timeoutMs`.
Step B adds one leaf module `core/exec/sandbox.ts` (imports only `./executable`, so ledger, worktrees and gate
can all use it without a cycle) and `core/host/project.ts` passes `run: sandboxedRunner(...)` where it builds the
`TestGate` (one line, line 319 today). Settings gets a switch, "Contain test commands", off by default at first
(opt-in), with the project's own setting stored where the other policy lives.

```ts
// core/exec/sandbox.ts
export interface SandboxPolicy {
  /** The only places the command may write: the task's worktree and a private scratch folder made per run. */
  writable: readonly string[];
  /** Read-only: the toolchain (Node, git, the OS runtime). Nothing else is visible. */
  readable: readonly string[];
  /** Never visible, even when inside something readable: the main checkout's .env, the app data folder,
   *  token files, other projects' folders (taken from TestRunOptions.protect plus registeredRoots()). */
  hidden: readonly string[];
  /** "none" is the default. A named list is a later step (a local allow-list proxy, see below). */
  network: "none" | { allowHosts: readonly string[] };
  limits?: { memoryBytes?: number; processes?: number; fileBytes?: number };
}
export type SandboxKind = "bubblewrap" | "appcontainer" | "none";
export interface SandboxStatus { kind: SandboxKind; reason?: string }   // reason in plain words when "none"
export function sandboxStatus(): Promise<SandboxStatus>;                  // cached; cheap to ask from Settings
export function sandboxedRunner(policyFor: (cwd: string, options: TestRunOptions) => SandboxPolicy): TestRunner;
```

- `policyFor` is built in core/host from the project: `writable = [worktree]`, `readable = toolchain dirs
  (appNodeDir(), git exec dir, the OS runtime)`, `hidden = options.protect` plus the app data folder.
- The runner keeps everything `runTestCommand` already does first (scrubbed env, PATH sanitising, planted-program
  refusal, timeout, tail), then starts the same command inside the sandbox, so the sandbox is a second wall, not a
  replacement.
- **Fail closed.** If "Contain test commands" is on and the sandbox cannot start (tool missing, user namespaces
  off, helper failed), the run returns `exitCode: null`, which `isConclusiveFailure` already treats as
  inconclusive, with an output line in plain words ("Not run: this computer cannot contain test commands
  (bubblewrap is not installed). Turn off Contain test commands to run uncontained."). It never silently runs
  uncontained.
- **Say how it ran.** The first output line of every run is either `[contained: bubblewrap, no network, writes
  only in the worktree]` or `[NOT contained]`, so the approval screen and the ledger entry show which.
- **Cleanup.** The whole tree is killed when the run ends, not only on timeout (bubblewrap `--die-with-parent`
  plus its own PID namespace; a Job Object with kill-on-close on Windows). That closes item 13.

**Linux: bubblewrap.** Needs: the `bubblewrap` package (`bwrap` on PATH; not present in this build container,
`docker` is), and unprivileged user namespaces allowed (on Ubuntu 24.04 and later the AppArmor setting
`kernel.apparmor_restrict_unprivileged_userns` blocks `bwrap` unless a profile for it is installed; some
hardened or container hosts turn user namespaces off). Shape of the command:

```
bwrap --die-with-parent --new-session --unshare-all          # pid, ipc, uts, net, user, cgroup namespaces
      --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/bin /bin (and /etc/ssl for certificates only)
      --ro-bind <node dir> <node dir> --ro-bind <git exec dir> <git exec dir>
      --proc /proc --dev /dev --tmpfs /tmp
      --bind <worktree> <worktree> --ro-bind <git common dir> <git common dir>
      --clearenv --setenv ... (the same scrubbed list)  --chdir <worktree>  /bin/sh -c "<command>"
```

`--unshare-net` removes every interface including the loopback to the host's bridge, so item 11 closes; the new
network namespace has its own loopback, so a test that starts and calls its own dev server still works. Nothing
outside the binds exists, so the main checkout's `.env`, the app data folder, other projects and `~/.ssh` are
absent rather than denied (items 4 to 10). The worktree's `.git` file points into the repo's git folder, which is
bound read-only: `git status`, `git diff` and `git log` work inside the test, `git add` and `git commit` do not
(see the open question). Resource limits via `prlimit` or a systemd scope when available.

**Windows: AppContainer and a Job Object, through a small signed helper.** Node cannot create a process with a
restricted token or an AppContainer, so this needs a helper executable (Rust, built with the Tauri side, signed
with the app) that takes the policy as JSON and prints the child's exit code. What it needs:

- *AppContainer* (`CreateAppContainerProfile`, process created with `SECURITY_CAPABILITIES` and no capabilities).
  This is an allow-list by construction: with no `internetClient` capability there is no network, and the user's
  profile, the app data folder, other projects and `~/.ssh` are unreadable because the container's SID is on none
  of their ACLs. The helper grants the container's SID read and execute on the toolchain folders (Node, Git for
  Windows; a per-user install is not world-readable, a Program Files one mostly is) and modify on the worktree,
  and removes those grants when the run ends. It must record the grants it made so a crash cannot leave them
  behind (a start-up sweep, never a silent delete of anything else).
- *Job Object* with kill-on-close, a process-count limit, a memory limit and UI restrictions: closes item 13 and
  caps runaway tests.
- *The restricted token plus low integrity the brief asked about is not enough alone.* A restricted token with a
  fresh restricting SID granted only on the worktree gives an allow-list for objects with ACLs, and low
  integrity blocks writes to medium-integrity files, but neither blocks the network and neither hides files that
  "Everyone" can read. Use it only as a fallback for the file rules, and report it as `[NOT contained]` for
  network, or add a Windows Firewall rule keyed to the container SID (needs admin once at install).
- *TEMP and TMP* point to a folder inside the worktree (`.pp-tmp`, git-ignored) because the container cannot use
  the user's temp folder.
- Antivirus and Controlled Folder Access can block the helper; the status line must say so in plain words.
- Everything in this list is untested: it cannot be tried on this Linux machine. A real Windows 11 run, with the
  ten gap tests flipped, is the acceptance test.

**macOS.** Parked (no macOS work in wave 1). `sandbox-exec` exists but is deprecated; decide later.

**Network, later.** "No network" breaks `npm install` and tests that call a real service. After the default is
in, an allow-list is a local proxy the sandbox can reach through a unix socket (Linux) or a loopback port that
only the container may use (Windows), with the proxy checking each host against `allowHosts`, and the allow-list
shown to the person before the run. Not part of the first cut.

**Open question for the worker (not the gate).** Workers must `git add` and `git commit` in their worktree,
which writes into the repo's shared git folder (objects, index of the worktree, the `pp/T-n` ref). Binding the
whole git folder writable gives a worker the other worktrees' refs and the objects of every branch; binding
only `<git dir>/worktrees/T-n` plus `objects` and `refs/heads/pp/T-n` is possible but fragile across git
versions. Two honest choices: (a) contain only the gate's test runner in step B, where the command needs no
commit, and leave workers as they are; (b) route a worker's commits through a host-run commit step (the worker
writes files, the host commits) so the worker's sandbox never holds the git folder. Recommend (a) first, then
(b). Decide before building.

**Acceptance for step B.** On Linux with bubblewrap and on a real Windows machine: flip the ten `it.fails` in
`isolation-exec.test.ts` to `it`; add a test that the runner fails closed when the sandbox cannot start; add a
test that the first output line says how the run was contained; keep the existing gate tests green with the
runner injected; and show the owner one real run (a test that passes, a test that fails, a test that tries to
read `../`).
