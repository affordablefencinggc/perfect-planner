# core/planning — deep planning: the hard questions first

Owner: the "Deep planning" thread. Plan section "Deep planning: the hard
questions first". Before any code, Perfect Planner researches the options,
forces the decisions models tend to skip, and turns the answers into a mind
map and a roadmap. "Later" is not an answer.

```
idea ──▶ profileIdea ──▶ question packs (10 areas) ──▶ live research (Sonar / Firecrawl)
                                  │
                                  ▼
             question.asked Q-n  (blocking or nice-to-know, with recommendation + confidence)
                                  │   answer: one tap, a pick, free text
                                  │   "TBD" / "later" ──▶ refused, or a dated spike task T-n
                                  ▼
       decision.made D-n ──▶ mind map ──▶ depth check ──▶ roadmap ──▶ task.created T-n
                                  │
                                  ▼
                plan.approved P-n  (refused while a blocker is open)
```

Import from `../planning/index`. Everything is plain Node; all state is
replayed from the ledger.

## Using it

```ts
import { Ledger, FileStore } from "../ledger/index";
import { installNumberingRules } from "../numbering/index";
import { PlanningSession, installPlanningRules, profileIdea, createSonarProvider } from "../planning/index";

const ledger = await Ledger.open(new FileStore(root));
installNumberingRules(ledger);
installPlanningRules(ledger);                       // the approval gate and the deferral catcher

const session = new PlanningSession(ledger, { person: "looplet-spare" });
const profile = profileIdea("Desktop invoice app with Stripe payments that works offline");
await session.startWithResearch(agent, profile, createSonarProvider({ keys }));   // or session.start(agent, profile)

session.open();                                     // questions with options, recommendation, confidence, sources
session.answer(owner, "Q-3", { choice: "sqlite-sync" });              // a pick (or the one-tap recommendation)
session.answer(owner, "Q-4", { text: "Stripe Checkout, no refunds in v1" });
session.answer(owner, "Q-5", { text: "TBD" });                        // throws PlanningError DEFERRED
session.answer(owner, "Q-5", { spike: { due: "2026-10-16", risk: "Wrong tax handling blocks EU sales." } });
session.acceptRecommendations(owner, 0.75);         // takes every confident recommendation at once
session.catchText(agent, planMarkdown, "P-1 draft"); // every "TBD"/"later" line becomes a blocking question

session.mindMap(profile.idea);                      // editable: addNode, removeNode, renameNode, linkNodes, toMermaid
session.depth(profile.idea);                        // shallow components, contradictory decisions
session.writeRoadmap(owner, session.roadmap(profile.idea, "looplet-spare"));   // task.created T-n per task
```

## Question packs (`packs.ts`, `profile.ts`)

One pack per area, in this order: stack, data, auth (users and auth), money,
ai (AI usage), offline (offline and sync), security (security and privacy),
scale (scale and cost), testing (testing and release), platforms. Each pack
has 3 or 4 questions; each question has 2 to 4 options, a `why`, a
`research` query, and a recommendation computed from the idea's signals
(`offline`, `payments`, `ai`, `mobile`, `desktop`, `web`, `team`,
`personal-data`, `realtime`, `files`) with a reason and a confidence from 0
to 1. Each area's core question is a blocker; some others become blockers
only when a signal makes them matter (offline → conflict rule, payments →
pricing and tax, ai → model, outage fallback, cost cap). Questions already
answered by a repo scan (`profile.known`) are not asked.

## Existing repos (`repo.ts`)

`readRepoStack(root)` reads what a repo already chose from `package.json` and
well-known files (`tsconfig.json`, `vercel.json`, `wrangler.*`, `fly.toml`,
`supabase/`, `src-tauri/`, `android/`, `ios/`), as text only: nothing is
imported or run. Each `RepoFact` names a question id, the matching option
when there is one, the stack in words and the files that show it.
`profileRepo(idea, stack)` adds the repo's signals and puts every fact in
`profile.known`, so `start()` does not ask it. `session.recordRepoFacts(actor,
profile, facts)` writes each fact as an answered question whose decision has
reason "Found in the repo: <files>" and those files as evidence, so the mind
map and roadmap build on the real stack. Mind map nodes a repo answer produced
are marked `existing` (risks never are), and `buildRoadmap` gives them no
build task: they are listed in `roadmap.existing` instead. Questions the code
cannot answer (pricing, offline, sign-in) stay open for a person. Found running Perfect Planner on
Looplet, where planning recommended Tauri, Expo and SQLite for an Electron,
Capacitor and Supabase app.

`/planning/start` in the host runs `readRepoStack` on the project folder and
records the facts before it asks anything, then records what the idea settles
(the idea wins over the repo). A `bin` or a plain library (an entry point and no
app, UI or server dependency) counts as "not an app": no framework, hosting,
store, sign-in or sync questions. The mind map skips an area whose answer
declines it, and the roadmap lists what the repo already has.

## The person's own description (`description.ts`)

The idea text is authoritative. `readDescription(idea)` is rule based (fixed
word lists, no model). Explicit negatives rule an area out: "no accounts",
"no login", "no sign-in/sign-up", "no passwords", "single user", "for one
person", "just me" (no sign-in, one role); "no cloud sync" (no sync engine,
no conflict rule); "no backend", "no server", "no cloud", "local only" (no
server); "offline only" (works offline, nothing syncs); "works offline", "no
internet" (works offline); "no payments", "no billing", "no subscriptions"
(not in v1, free); "no AI", "no LLM" (no AI); "no sharing", "no teams" (solo).
One negation covers a list ("no accounts, payments or AI") but never the
words after it ("no login that syncs" still syncs). Explicit positives answer
one question: TypeScript, Python, Next.js, SvelteKit, Vite, React, Vercel,
Fly.io, Cloudflare, SQLite, Postgres, Supabase, MySQL, MongoDB, Firebase,
IndexedDB, Prisma, Drizzle, magic link, Google/GitHub sign-in, email and
password, Clerk, Auth.js, Stripe, Paddle, one-time/usage/subscription
pricing, Tauri, Electron, Expo, React Native, Flutter, Swift/Kotlin, PWA. A
negative beats a positive for the same question; a stated sign-in method beats
"single user". `profileIdea` drops what a negative rules out from the signals
and puts every settled question in `known` and `described`;
`session.recordDescriptionFacts(person, profile)` writes each as the person's
decision with reason `From your description: "<their words>"` and
`data.source: "description"`. `session.reopen(person, q)` asks one again.

The person can also add their own task (`session.addTask`, a person-signed
`task.created` with `data.source: "person"`, on the agent board at once) and
leave a draft roadmap task out before approval (`dropRoadmapTask` /
`restoreRoadmapTask`, recorded as their `decision.made` with `data.roadmap`).

## Live research (`research.ts`)

`ResearchProvider { name; available(); research(query, signal?) }` with
`createSonarProvider` (Perplexity Sonar, cited answers), `createFirecrawlProvider`
(search plus page content), `createMockProvider` (tests, offline previews) and
`withFallback(...)`. `researchQuestion` attaches sources to a question's
recommendation and never throws: research must never block planning.

Keys come only through `ResearchKeyProvider { read(): Promise<SecretLike | null> }`,
the same shape as the check-in thread's `JevKeyProvider` / `SecretKey`, so an OS
keychain provider for the research key drops in unchanged. The key is revealed
only to build the Authorization header; every error and result is scrubbed with
`SecretLike.scrub`, and nothing reads the environment or the clipboard.

## The deferral catcher (`catcher.ts`)

`catchDeferral(text)` flags TBD/TBC, "to be decided", "later", "figure it
out", "not sure", "eventually", "we'll see", "maybe", "depends", "defer",
TODO, "whatever", "???" and blank answers. `findDeferrals(text)` finds them
line by line in a plan. A deferral must become a decision, or a spike:
`{ due: "YYYY-MM-DD", risk: "<a real sentence>", owner? }`, due today or within
`MAX_SPIKE_DAYS` (30), with a risk that is not itself vague.

## Ledger entries and rules

| Step | Entry | Payload |
|---|---|---|
| Ask | `question.asked` `Q-n` | `{ task: "plan", person, question, options: string[], blocking, planning: { id, area, options, recommendation, why } }` (relay-compatible, so planning questions show in the main chat's inbox) |
| Decide | `decision.made` `D-n` | `{ question: Q, questionText, answer, choice, planning: { id, area } }`, reason = the recommendation's reason or the person's |
| Close | `question.answered` `Q-n` | `{ answer, decision, via: "main" }` or `{ answer, via: "spike", spike: { task, due, risk } }` |
| Spike | `task.created` `T-n` | `{ change: "fix", phase: "foundation", owner, doneWhen, spike: { question, due, risk, owner }, source: "planning" }` |
| Roadmap | `task.created` `T-n` | `{ change, phase, owner, doneWhen, node, dependsOn: T-n[], key, source: "planning" }` |

`installPlanningRules(ledger, { scope?: "planning" | "all" })` adds, through
`ledger.addRule`, rules that hold whoever writes (the session, the relay's
`answer()`, MCP tools, the app):

- `plan.approved` is refused while a blocking planning question is open
  (`scope: "all"` counts every blocking relay question too).
- `decision.made` or `question.answered` on a planning question is refused
  when its answer is a deferral, unless it is a spike answer.
- A spike answer must name a `task.created` that carries `data.spike`, and a
  spike task needs a valid due date and a written risk.
- Only a person answers a planning question: `decision.made` and
  `question.answered` on one are refused unless the entry's own actor has
  kind `person` (payload fields never count). `PlanningSession.answer` refuses
  the same up front with `PERSON_ONLY`. Agents and Jev may still ask.
- A planning question cannot be answered twice.

Relay questions (no `data.planning`) are untouched.

Who writes what follows the ledger's permissions table: an agent may ask
planning questions but never answer them, but spike tasks and roadmap tasks are
`task.created`, so a person (or the system) writes them, and `plan.approved`
comes from a person.

## Views (`state.ts`)

`planningQuestions(entries)`, `openBlockers(entries, scope?)`,
`planningAnswers(entries)` (the mind map's input), `allQuestions(entries)`.

## Mind map, roadmap, depth check

`buildMindMap(idea, answers)` maps answers to components, data, screens,
integrations and risks (spikes become risk nodes); edits are pure
(`addNode`, `removeNode`, `renameNode`, `linkNodes`) and `toMermaid` renders
it. `buildRoadmap(map, { owner })` splits it into foundation, core,
integrations, hardening and release phases; every task has an owner and a
testable done-when. `depthCheck(map, answers)` flags components nobody broke
down and decisions that contradict each other (offline-first with a
server-only store, no sign-in with roles, and so on).

## Tests

`npm run test:core` and `npm run typecheck:core`, on Windows, macOS and Linux
in core CI.
