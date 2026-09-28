# Developer feedback → Perfect Planner product requirements

Research date: September 5, 2026. Scope: public developer feedback on Git/branch/worktree tools, multi-agent work, merge queues, CI, review and recovery. Focus: 2025–2026 accounts, supported by older recurring-pain research. Audience: beginners plus experienced developers; “high-end” is not an objectively verifiable qualification for anonymous posts. This is a focused qualitative scan, not all feedback, a representative market study or proof of product-market fit.

## Executive read

The opportunity is to remove coordination work without hiding control. Negative feedback repeatedly concerns context loss, opaque automation, uncertain status and costly recovery. Experienced users also need familiar tools and exact change inspection; simplifying the default does not require forcing a new workflow on them. Beginners need clear outcomes, visible scope and a safe next step rather than Git terminology. A Simple view and an optional Advanced view should share one underlying state machine and safeguards, though their presentation can differ. These findings justify testable design hypotheses, not a promise that one design will satisfy everyone.

## Ranked problem clusters

Priority is our product judgement based on severity, recurrence in this selected sample, evidence strength and leverage. Frequency below is a signal, not estimated population prevalence. Recommendations are inferences, not statements made by the sources.

### 1. Loss of work and opaque recovery — critical reliability/trust

Goal: integrate changes without sacrificing unfinished work. Surface: worktree switching, merge/rebase and cleanup. GitButler's recovery documentation explicitly addresses lost-work investigation through refs and an operations log. A 2026 VS Code report describes a transient Git failure being persisted as a settled project identity with no normal repair affordance. These establish concrete recovery and uncertain-state failure modes, not their prevalence. [GitButler recovery](https://docs.gitbutler.com/troubleshooting/recovering-stuff), [VS Code #329943](https://github.com/microsoft/vscode/issues/329943).

Signal: cross-product examples; high confidence that the failure class exists, unknown incidence. Product move: preserve-first transactions, visible retained-work inbox, verified checkpoints, and an explicit distinction between unavailable, missing and deleted. No automatic cleanup because an agent stopped responding. T85 owns engine/recovery guarantees; T83 owns understandable recovery presentation.

### 2. Successful checks but unexplained queue blockage — high workflow/reliability

Goal: know whether integration is progressing and what requires action. A February 2026 GitHub discussion initially blamed an incident, but its author's final explanation was a queue timeout shorter than the build timeout: the queue removed a PR while its job later passed. The chronology matters; this is not evidence that GitHub arbitrarily ignored green checks. [GitHub discussion #186339](https://github.com/orgs/community/discussions/186339).

Signal: one detailed self-hosted-runner case, with older queue complaints supporting recurrence; high confidence in reported confusion, not universal cause. Product move: expose queue position, current wait reason, job/queue deadlines, freshness and safe retry choices. Keep local checks, combined-candidate checks, remote push and deployment separate. T80/T85.

### 3. Forced workflow changes and lost review context — high adoption/UI

Goal: retain speed and direct inspection while trying new tooling. GitButler's 2024 waitlist survey had 1,253 responses; 82% selected CLI use, while only 8% used a GUI exclusively. Roughly 30% reported branch/commit-management frustration. These are vendor/self-selected results, not all developers. [The Git Zeitgeist](https://blog.gitbutler.com/git-zeitgeist).

A Cursor discussion criticizes repeated worktree approvals, slower setup and removal of obvious repository context; commenters value inline diffs. This is first-person feedback with unverified seniority, not product-wide prevalence. [Cursor V3 discussion](https://www.reddit.com/r/cursor/comments/1sc55tc/cursor_v3_is_a_significant_regression/).

Signal: survey plus anecdotes; medium-high confidence in adoption risk. Product move: make advanced coordination opt-in, preserve project context and familiar editor/CLI access, offer inspectable diffs in either view, and avoid routine repeated approvals within an already approved bounded operation. Do not infer that developers universally dislike change. T83.

### 4. Searching across tools and excessive process overhead — high workflow

Goal: find the relevant decision, owner and evidence without rebuilding context. Atlassian's 2025 survey of 3,500 developers/managers across six countries reports finding information, adapting new technology and context switching among top time-wasters. It reports 50% losing at least ten hours weekly to non-coding inefficiencies. This is vendor research and self-report, not measured time for Perfect Planner. [Atlassian 2025 research](https://www.atlassian.com/blog/developer/developer-experience-report-2025).

Signal: broad survey; high confidence in the general problem, not our solution. Product move: one package links scope, owner, dependencies, decisions, change preview and proof. Keep the mind map summarized and the Ledger detailed; do not require every project to fill enterprise paperwork before a harmless read-only import. T83, constrained by genuine security/authority gates.

### 5. Automation that looks right but adds verification work — high trust

Goal: judge real correctness quickly. Stack Overflow's 2025 survey reports 66% encountering almost-correct AI output and 45% finding AI-code debugging more time-consuming. Its experienced cohort (10+ years of work) is particularly cautious about accuracy. Response counts vary by question and the survey is self-selected. [2025 AI results](https://survey.stackoverflow.co/2025/ai), [methodology](https://survey.stackoverflow.co/2025/methodology).

Signal: broad survey with an identified experience cohort; high confidence in reported concern, not a claim that all automation slows users. Product move: evidence-first review, exact candidate identity, clear changed files and explanations, scoped proof, honest unknowns and human decisions for substantive conflicts. No green animation standing in for executed checks. T80/T84/T85.

### 6. Large-project lag and over-eager watching — high performance

Goal: switch projects, review changes and keep working while background indexing runs. VS Code reports document expensive recursive watching across worktrees and an August 2026 session-switch freeze involving thousands of changed-file entries and repeated catalogue work. These are concrete maintainer-filed reproductions, not evidence that every VS Code session has the problem. [#305926](https://github.com/microsoft/vscode/issues/305926), [#332670](https://github.com/microsoft/vscode/issues/332670).

Signal: multiple detailed technical reports; high confidence in failure modes. Product move: bounded incremental indexing, virtualized graphs/lists, deduplicated watchers, cancel/resume, resource budgets and honest incomplete coverage. Measure foreground responsiveness under large-repository and partial-deletion scenarios. Never animate node reflow by moving the user's viewpoint unexpectedly. T84 and discovery requirements.

### 7. CI configuration, documentation and security setup — high onboarding/developer friction

Goal: enable checks without writing or debugging unfamiliar configuration blindly. A 2023 study of 90 GitHub Action developers/users found YAML composition challenging for 60.87% and identified setup effort, security and complexity as reasons to avoid automation. The study is small and historical. [Saroar and Nayebi](https://arxiv.org/abs/2303.04084).

Signal: structured survey; medium confidence for today's incidence. Product move: read existing configuration first, explain missing prerequisites, preview generated edits, verify provider permissions, offer minimal scoped connections and link errors to affected checks. Connected is not tested, and a tool name is not a malware verdict. T81/T82.

## Counterevidence and independent challenge

Do not sell “AI makes experts slower” from one old result. METR's early-2025 study involved 16 experienced maintainers and 246 tasks; its February 2026 update explains why later estimates suffer selection and measurement problems and why a blanket current slowdown conclusion is unjustified. Our acceptance metric must be actual task completion, review/recovery effort and errors—not perceived speed or number of agents. [METR 2026 update](https://metr.org/blog/2026-02-24-uplift-update/).

Do not equate transparency with showing raw commands everywhere. VS Code documents GUI Git operation alongside CLI compatibility; its worktree guidance makes creation and opening accessible while documenting ignored-file limitations and comparison tools. A beginner can be shielded from mechanics while still seeing scope, changes and consequences. [Source-control overview](https://code.visualstudio.com/docs/sourcecontrol/overview), [branches and worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees).

An independent review challenged the initial “same workflow” wording: we need the same underlying state and safety, not identical screens. Simple should offer preserve/inspect choices first; Advanced can expose exact refs and repair details. Neither should claim ignored credentials/dependencies were copied when they were not. Public issues and comments establish useful failure cases; they do not establish how often our intended customers encounter them.

## Proposed two-view contract — not implemented yet

| Need | Simple, default | Advanced, opt-in |
| --- | --- | --- |
| Orientation | Project, package, current step and next action | Same identity plus branch, worktree, base/source/candidate IDs |
| Understanding changes | Plain summary with Open changes available | Detailed diffs, staged/untracked/ignored inventory and dependency claims |
| Integration | Prepare, check, review, integrate with consequences explained | Queue policy, merge strategy, exact check inputs and approvals |
| Failure | What happened, what is safe, what to do next | Redacted logs, command outcomes, hooks, provider responses and receipts |
| Recovery | Visible retained work and guided preservation | Transaction history, exact paths, identities and recovery diagnostics |
| Control | Minimal approved scope; no surprise uploads | Explicit configuration and automation policy; no bypass of safety |

Mode switches must preserve selected project/package, unsaved input, scroll/filter state and underlying receipts. Both views must retain readable text, keyboard navigation, useful focus order, zoom and right-side scrolling. Advanced is not synonymous with tiny text or a wall of widgets. Prefer labels “Simple” and “Advanced” over labelling people beginners/experts.

## Opportunity map and acceptance tests

**This week / next bounded pass:** record this contract; replace unclear state labels; design the Simple primary path and Advanced detail entry against the selected visual direction; connect obvious errors to actionable details; make current package and recovery available without hunting. Preserve existing workflow and safety decisions. Deliver before/after captures for each actual UI change. These are priorities, not promised delivery dates.

**This quarter / later engineering milestones:** prove preservation/restart handling, implement queue deadline/candidate explanations, optimize large repo interactions, and deliver editor/CLI continuity and scoped hook/provider setup. Backend authority and UI must advance together.

**Needs direct research:** recruit beginners and experienced maintainers to test the same import → start package → review conflict → integrate → recover scenarios. Public negative feedback cannot settle terminology, default density, trust, willingness to migrate, privacy boundaries or willingness to pay.

Proposed acceptance criteria, not measured results:

1. Cross-mode identity is exact: every participant can identify the same project/package before and after switching; zero unintended mutations or lost edits. An experienced user can reach raw diff and exact workspace within two deliberate actions.
2. Inject dirty files, changed base, missing folder and interrupted merge. Users must see retained work and choose safe inspection; target at least 90% correctly explaining what will be retained before confirming. Zero lost fixture files/commits is mandatory.
3. Introduce ignored `.env`/dependencies and two concurrent projects. Users must not assume excluded content is copied or connected; permission and outgoing-data previews must match actual behaviour.
4. Measure completion rate, error rate, time, assistance requests and recovery effort separately for both groups. Test CLI/editor edits while the app is open and large-repo indexing while navigating. Fewer clicks alone is not success.

## Source map and limits

- Strongest experience-specific evidence: Stack Overflow's explicit 10+ years cohort and METR's experienced-maintainer research. Neither proves elite expertise or represents all developers.
- Recurring workflow categories: GitButler and Atlassian surveys; both have vendor incentives and selection/self-report limits.
- Concrete defects: first-party VS Code reports and GitHub discussions. Read final updates; report dates and states can change.
- Qualitative language: Reddit/Cursor and Hacker News/Jujutsu discussion search. Anonymous seniority and incidence are unknown; these informed hypotheses, not technical truth. HN was not needed to establish a current product defect.
- Search covered public GitHub, Reddit, Hacker News, vendor research and academic reports. X, private support, internal analytics, paywalled reviews and user interviews were not available/used. No exhaustive scan of every channel, negative review or product was performed.
- Technical responses/workarounds in comments were not adopted as instructions or executed. No third-party code was copied. The clean-room app remains the implementation source.
