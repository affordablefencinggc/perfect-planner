# core/release — shipping safely

The "Shipping safely" section of the plan: review priced by risk, four
layers against secret leaks, no giant pushes, no wasted CI, a monthly budget
cap and one-click rollback. Plain Node, every side effect (git, GitHub, the
test runner, the small model, the deploy) is injected, so it all runs in
tests on Windows, macOS and Linux. Import from `../release/index`.

Owner: the "Shipping safety and review presets" thread. Writes to the ledger
only through `Ledger.append` (and `core/numbering` for release numbers).

## Review presets (`presets.ts`)

| Preset | Deep review runs | Full test suite | Best for |
|---|---|---|---|
| `cheap` | only on sensitive areas | once per merge batch (8) | Solo projects and prototypes |
| `balanced` (default) | sensitive areas, plus anything triage rates medium or high | once per merge batch (5) | Most projects |
| `thorough` | every change | every merge (batch of 1) | Production apps with real users or money |

```ts
currentPreset(entries)                        // "balanced" until someone chooses
setPreset(ledger, person, "thorough", reason) // decision.made D-n, data { topic: "review-preset", preset }
needsDeepReview(preset, triage)               // { deep, why }
```

Only a person can change the preset or the budget, enforced twice: the
readers (`currentPreset`, `currentBudget`) count only entries that pass
`isAuthoritative(entry, { personOnly: true })` from `core/ledger`, and `installSettingsRule(ledger)` refuses a system `decision.made` on either topic
outright (the ledger itself already refuses agents and Jev). The gate reads the preset
from the ledger (`runCheapFirst(change, { ledger, author })`); callers cannot
pass one in.

## On by default (`protect.ts`)

The host calls this once when it opens a project (`openCoreProject`):

```ts
await protectProject(ledger, { run, cwd: repoRoot }) // { rules: "on", prePush: { state, path, reason } }
```

It installs the release rules on the ledger and the whole-branch secret scan
as the repository's pre-push hook (`DEFAULT_PRE_PUSH_SCRIPT`). The rules have
no off switch. The pre-push scan can be switched off only by a person's
signed decision (`setPrePushScan(ledger, person, false, reason)`, topic
`release-safety`); a system or agent entry is refused, and one written before
the rule existed is ignored. Switching it off removes only our own hook.
`prePush.state` is `installed`, `opted-out`, `foreign-hook` (the repo has its
own hook, left alone; chain the scan into it by hand) or `not-a-repo`.

Known bypasses of the pre-push scan (it is a local, best-effort layer):
`git push --no-verify` skips every pre-push hook, and in the `foreign-hook`
state the repository already had a pre-push hook that is not ours, so ours is
not installed and nothing scans until a person chains it in. Neither bypasses
the review gate (`runCheapFirst`) or GitHub push protection, which are the
binding checks.

## Protect `main` on GitHub (your setting)

A direct push to an unprotected `main` skips review and CI, and no code in
the app can stop it. On GitHub, open the repository's **Settings > Branches
> Add branch protection rule** (or **Settings > Rules > Rulesets > New branch
ruleset**), branch name pattern `main`, then tick:

1. **Require a pull request before merging**.
2. **Require status checks to pass before merging**, and add: `Core loop on
   ubuntu-latest`, `Core loop on macos-latest`, `Core loop on windows-latest`
   (core), `Web, contracts, MCP, and Sites` (web) and `Windows native compile
   and tests` (guardrail).
3. Leave **Allow force pushes** and **Allow deletions** off.
4. Optional: **Do not allow bypassing the above settings**, so admins follow
   them too.

## Cheap checks first (`pipeline.ts`, `risk.ts`)

`runCheapFirst(change, { ledger, author, ... })` runs, cheapest first, and
stops at the first check that does not pass, so a held change never spends
money on the later ones. It fails closed: without the ledger (preset and
budget) or the builder (`author`, for reviewer independence) it throws
instead of running with defaults. It also installs the release rules on the
ledger (`installReleaseRules`: budget stop plus person-only settings, once per
ledger). The host also installs them when it opens a project, through
`protectProject` (below), so they hold before the first review.

1. **budget**: a stopped month holds everything (free)
2. **size-cap**: oversize changes are held with a split plan (free)
3. **secret-scan**: added lines and file names (local)
4. **local-tests**: only the tests for the changed files (`affectedTests`), via `options.runTests`
5. **risk-triage**: path rules, then an optional small model that may raise but never lower the level; it sees paths and line counts only, never file contents
6. **deep-review**: only when the preset says so; the reviewer (Jev, `core/jev`) is passed in as `options.deepReview` and must name itself (`outcome.reviewer`). A change that needs one with no reviewer configured is held, never waved through, and so is one reviewed by its own builder (same id, or an AI reviewer on the same model as the builder, compared without case).

Verdict is `ready`, `held` (size, budget, missing reviewer) or `blocked`
(secret, failing tests, rejected review). Skipped checks are reported as
skipped, never as passed. `recordPipeline(ledger, gate, "T-14", result)`
writes it as `review.verdict` with `data.stage = "cheap-first"`; the actor is
the system gate (or Jev), since agents may not write verdicts.

Sensitive areas (`areasOf`): auth, payments, migrations, secrets handling,
CI and build config, any test file that is deleted or loses a line
(`isTestFile`: `*.test.*`, `*.spec.*`, `__tests__/`, `tests/`, `test_*.py`,
`*_test.go`, `*Test.java`; swapping assertions for comments keeps the
line count, so any removed line counts), and anything over the
planned size. Every sensitive area except oversize gets the deep review under
every preset, Cheap included.

## Four secret layers (`secrets.ts`, `layers.ts`, `pushProtection.ts`, `hooks/pre-push.mjs`)

| Layer | Who installs it | Here |
|---|---|---|
| 1. Agents never hold real secrets | `core/worktrees` (placeholder env files) | `secretPosture` re-checks worktree env files |
| 2. Scan on every commit | `core/worktrees` (`hooks/secret-scan.mjs`) | reported by `secretPosture` |
| 3. Whole-branch scan before any push, plus an enforced ignore list | this module | `scanBranch`, `hooks/pre-push.mjs`, `checkIgnoreList`, `withRequiredIgnores` |
| 4. GitHub push protection on | this module | `checkPushProtection`, `enablePushProtection` |

`secretPosture(facts)` turns what the app checked into one report per layer:
`on`, `off` or `unchecked`, and `ok` only when all four are checked and on.

Findings never carry a secret: `preview` is masked (`ghp_…(40)`), and the
GitHub token never appears in a result or error. There is no inline
"allow" marker. A finding a person has reviewed is allowed by its exact
fingerprint (`file:rule:scrypt(value)`, salted with file and rule so short
values cannot be guessed back). The review gate honours a fingerprint only
when a person approved it in the signed ledger
(`approveSecretFinding(ledger, person, { fingerprint, reason })`, read back
with `approvedFingerprints(entries)`, checked with `isAuthoritative(entry, {
personOnly: true })`); a file on a branch approves nothing, so two pushes
cannot approve their own secret. The local pre-push hook cannot verify
ledger signatures, so it reads `.perfect-planner/secret-allowlist.json` from
the remote default branch only, where an entry arrives through review; it is
a best-effort local layer, and the binding checks are the gate and GitHub
push protection. Any path under `.perfect-planner/` (the ledger, worker tokens, briefs,
keys) is refused whatever it holds (`planner-state`), except the reviewed
allowlist file. A quoted value that only names a field (`"passwordLabel":
"Password"`) is a label, not a credential. A value counts as a
placeholder only when the whole value is one (`changeme`, `<token>`,
`${API_KEY}`, …) or a reference to a secret store (`secret://…`, `dpapi:…`,
`keychain:…`).

Detection is `core/secrets` `detectSecrets`, the same check Jev runs on a
diff, so the push scan is exactly as strict as Jev's (env-style
`NAME=value` lines, connection-string passwords, `mysql -p`, `curl -u`,
`sk_test_` keys, session cookies, and the vendor token formats).
`secrets.ts` adds forbidden file names, the `.npmrc` token, fingerprints and
the branch scan. The pre-push hook is a dependency-free `.mjs` (git cannot
run TypeScript) that imports `hooks/secrets-detector.mjs`, a JS copy of
`core/secrets` generated by `node core/release/hooks/build-detector.mjs`;
`secrets.test.ts` fails when that copy is stale or the hook's results differ
from `scanText`.
Install it with `installPrePushHook(run, { cwd, hookScript })`, which writes
the shim where git looks (`git rev-parse --git-path hooks`, so it follows the
`core.hooksPath` that `core/worktrees` sets) and never overwrites a hook that
is not ours; `prePushInstalled` feeds layer 3 of `secretPosture`.

Run on every tracked file of this repo today it flags 52 lines, nearly all
test fixtures or non-secret values under secret-like names (for example a fake
PEM header in `tests/provider-review-gateway.test.mjs`). They only matter
when a branch changes one of those files, and then a person approves the
printed fingerprint in the ledger (and, for the local hook, on the default
branch's allowlist file).

## No giant pushes (`sizeCap.ts`)

Cap = `min(planned × 2, 800)` changed lines (lock files, snapshots, minified
and `dist/` files count as zero). Over the cap the change is held and
`planSplit` proposes parts under the cap, keeping each test with its source.
`parseNumstat` reads `git diff --numstat`.

## No wasted CI (`ciPlan.ts`, `ci/merge-queue.yml`)

Per push: only the affected tests (all of them when shared config changes).
Full suite: once per merge-queue batch (`merge_group`), on Windows, macOS and
Linux. Older runs are cancelled when a newer push lands. Deploys go
integration → preview → staging → production.

`ci/merge-queue.yml` is the ready workflow (generated by
`mergeQueueWorkflowYaml`, a test keeps them identical). It lives under
`core/` so it is not active; to switch the queue on, copy it to
`.github/workflows/` and create the ruleset from
`mergeQueueRuleset(ciPlanFor(preset), { requiredChecks })` via
`POST /repos/{owner}/{repo}/rulesets`. `estimateMonthlyCiMinutes` shows the
saving against "full suite on every push".

## Monthly budget (`budget.ts`)

Spend rides on ledger entries as `data.cost = { cents, kind: "ci" | "model" }`
(`recordSpend`). The budget is a person's `decision.made` with
`data.topic = "budget"` (`setBudget`). `checkBudget(ledger, system, now)` writes one
`budget.warning` (as a system actor; the ledger only lets a person or system
write it) at 80% and one at 100% per month (again after a raise is
crossed). `installBudgetRule(ledger)` refuses new runs (`task.claimed`,
`worktree.created`) at 100%; proof, done, releases and raising the budget
still go through, so work in flight can finish.

## One-click rollback (`rollback.ts`)

```ts
rollbackCandidates(entries)   // earlier releases, newest first, with stamps; [0] is the default
await oneClickRollback(ledger, person, { reason, to?: "R-1", deploy })
```

The deploy runs first; only when it succeeds is `release.rollback` written,
as a new release with the next `R-` number and a patch bump
(`core/numbering`). A failed deploy writes nothing. Clicking again undoes the
rollback, still as a new release.

## Tests

`npm run test:core` and `npm run typecheck:core`; this module's tests are
`core/release/*.test.ts`.
