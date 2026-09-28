# Wave two · scoped change evidence

Captured: 2026-09-02 (Australia/Brisbane)

This workspace has no Git metadata. This is a behavioral before/after manifest, not a fabricated line diff.

| Scope | Before | After | Proof |
|---|---|---|---|
| C024 lock and journal durability | Stale-lock recovery, link substitution, and disk-sync completion were unresolved. | A named actor must first inspect the exact stale holder; clearance refuses changed tokens/timestamps and links/junctions; journal success waits for file sync. | Truth-core, runner, confirmation, and session adversarial suites pass. |
| C011 human confirmation | Callers could represent gesture truth too loosely; cancellation/retention lacked a complete lifecycle. | Only a branded trusted gesture boundary is accepted; exact watchers may cancel with a reason; pruning retains hashed terminal receipts and never deletes pending work. | Focused local-authority tests pass. |
| C008 planning ownership | Blueprint and Rulebook responsibilities overlapped. | Blueprint terminates at `READY_FOR_PLANNING`; Rulebook exclusively owns compatibility, `READY_FOR_ARCHITECTURE`, and freeze under boundary version `2026.09.1`. | Boundary mutation tests pass. |
| C025 truth publication | Truth, completion, and evidence outputs were sequential files and C001/C003 dependencies were decorative. | C001 catalog and C003 collision truth are directly assessed; four artifacts are staged, parsed, hashed, atomically published as one generation, reopened, verified, then committed through one pointer. | Atomic-publication adversarial tests and real generation pass. |
| C012 Allocation | UI rows came from static fixture data. | Allocation renders actual `deriveExecutionMap` and `allocateConveyor` output, dependency-aware schedules, P50/P80, reserved identities, and blocked collision truth. | Engine/model tests and `wave-two-allocation-proof.png`. |
| C009 research transport | Live metadata transport was absent. | Exact approved credential-free public HTTPS origins may return bounded JSON evidence for assessment only; private/local targets, redirects, malformed data, and overflow fail closed. | 4/4 adapter tests pass. |

Combined gate: 294/294 tests pass. Production build and atomic truth publication pass. Catalog remains blocked by 31 explicit remaining questions with zero naming or file collisions.
