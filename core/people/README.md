# core/people — people on a project

Spec §9: solo first, helpers allowed. Who is on the project, what each person
may do, where everyone is, their profile photos and the original documents
everyone can see. Everything is a ledger entry; `buildPeopleView` rebuilds the
whole picture by replaying the ledger, so a second device that pulls the
ledger through git sees the same view. There is no network service here.

Owner: the "People and shared documents" thread. The panel that shows this
lives in `src/people/` (see the end of this file).

## Roles

| Role | May |
|---|---|
| `owner` | everything; adds, changes and removes people; shares documents; one per project |
| `helper` | claim tasks, progress, ask and answer, commit, define tests; approves only what the owner granted: `plan`, `test`, `release`, `review` |
| `viewer` | read only; any write by a viewer or a viewer's agent is refused |

`APPROVAL_TYPES` maps each approval to the entry types it unlocks
(`plan` → `plan.approved` and `clause.*`, `test` → `test.approved`,
`release` → `release.*`, `review` → `review.verdict`).

## Writing

```ts
import { installPeopleRules, claimOwnership, addMember, changeMember, removeMember,
         setPhoto, clearPhoto, shareDoc, removeDoc, FilePhotoStore } from "../people/index";

installNumberingRules(ledger);   // people entries take D-n numbers
installPeopleRules(ledger);

claimOwnership(ledger, me, "Looplet Spare");                       // first member, always the owner
addMember(ledger, me, { person: "mia", name: "Mia", role: "helper", agents: ["mia-worker"] });
changeMember(ledger, me, "mia", { approves: ["test"] });
setPhoto(ledger, new FilePhotoStore(projectRoot), mia, "mia", bytes);
shareDoc(ledger, me, { title: "Core specs", path: "specs/CORE-SPECS.md", clauses: ["§1", "§9"] });
removeMember(ledger, me, "mia", "Finished her part");
```

Each call appends one `decision.made` entry (numbered `D-n` through
`appendNumbered`) with the change in `data.people` and a reason. People
changes ride on `decision.made` because `ENTRY_TYPES` is closed and owned by
the ledger thread, and a membership change is an owner's decision. If the
ledger later gains `member.*` types, only `actions.ts` and `peopleEvent` in
`model.ts` change.

| `data.people.op` | fields |
|---|---|
| `member.added` | `person`, `name`, `role`, `approves?`, `agents?` |
| `member.changed` | `person` and any of `name`, `role`, `approves`, `agents` |
| `member.removed` | `person` |
| `photo.set` | `person`, `file`, `sha256`, `bytes`, `mime` |
| `photo.cleared` | `person` |
| `doc.shared` | `doc`, `title`, `path` (project path or https URL), `clauses?` |
| `doc.removed` | `doc` |

Person and document ids are lowercase slugs (`looplet-spare`), safe as file
names on every OS.

## Rules (`installPeopleRules`)

The write helpers install these rules on the ledger the first time they are
used (installing twice is a no-op). The same checks also run on **replay**:
`replayRoster` and `buildPeopleView` ignore any people entry the rules would
have refused, so an entry appended directly (by an agent, or to a ledger that
never installed the rules) cannot add an owner or change a role. Authority
comes from the actor of each entry and the ledger's history, never from the
payload alone: replay applies a people entry only when
`isAuthoritative(entry, { personOnly: true })` from core/ledger says a person
wrote it, and the ledger never lets an agent or Jev write `decision.made`.

- **Solo first.** Until the first member is added nobody is restricted, so a
  project that never adds helpers behaves exactly as before. The first member
  must be the person writing, as owner, and if the ledger already has
  entries by a person, only the first such person (who started the project)
  can claim it.
- Only a person (never an agent) changes people. Only the owner adds,
  changes or removes people and shares documents. One owner, who cannot be
  removed or demoted. Approvals belong to helpers only.
- Once there is a roster, a person who is not on it cannot write. Viewers
  cannot write. Helpers cannot write approval types they were not granted.
- These rules run after the ledger's own "who may write what" table
  (`DEFAULT_PERMISSIONS`, by actor kind), so an agent never approves, records
  test results or creates tasks whatever its person may do. That table is per
  actor kind; roles are per person, so they live here as a ledger rule rather
  than in the table.
- A member's agents (`agents`) are held to that member's role, and an agent of
  a removed member is refused. Once there is a roster, an agent nobody has
  listed is refused (default deny). Jev and the system actors (gate, watcher)
  are governed by the ledger's permission table only.
- Shared document paths are relative to the project (no leading `/`, no
  `..`, no drive letter or scheme) or an https link.
- Photos: people set their own (the owner may set anyone's). The file must be
  `.perfect-planner/people/photos/<person>-<first 12 of sha256>.<ext>`.

## Profile photos

Local images only, never uploaded: PNG, JPEG, WebP or GIF, detected from the
bytes (SVG and anything else refused), at most 512 KB (`PHOTO_MAX_BYTES`).
`FilePhotoStore(root)` writes them atomically under
`.perfect-planner/people/photos/`, so they travel with the repo like the
ledger. The ledger records the fingerprint; `loadPhoto` and `photoSources`
drop a photo whose bytes no longer match, so a swapped file is never shown.
`setPhoto` writes the entry first (a refused change leaves no file) and clears
the photo again if the file cannot be saved. `clearPhoto(ledger, actor,
person, store)` deletes the file as well.

## Reading

```ts
const view = buildPeopleView(ledger.entries());
// { members: Member[] (owner first), owner?, docs: SharedDoc[], head? }
const photos = photoSources(view, new FilePhotoStore(projectRoot)); // person -> data URL
```

- `member.presence` (§9.4) is the member's latest work entry, by them or one
  of their agents: `stage` (plan, task, relay, git, proof, release, people,
  housekeeping), `subject` (T-14, P-2 §3.1, Q-3), `summary`, `at`, `via` (who
  wrote it) and `task`, the newest task they touched that is not done.
  Profile changes only count for someone who has done nothing else.
- `docs` (§9.3) is the latest approved plan (version `P-n`, title and path
  from its `data` when present, clauses from `clause.*` entries) followed by
  the owner's shared documents (version `v1`, `v2`… one per share).

## The panel (`src/people/`)

`PeoplePanel` is a self-contained React component that takes a ready view and
draws people, roles, photos, presence, a "where everyone is" strip by stage and
the shared documents. It makes no network calls and imports nothing from
core, so it can be mounted anywhere:

```jsx
<PeoplePanel view={view} photos={photos} me="looplet-spare"
  onAddMember={({ person, name, role }) => addMember(ledger, me, { person, name, role })}
  onChangeRole={(person, role) => changeMember(ledger, me, person, { role })}
  onRemoveMember={(person) => removeMember(ledger, me, person)}
  onSetPhoto={async (file) => setPhoto(ledger, store, me, me.id, new Uint8Array(await file.arrayBuffer()))}
  onShareDoc={({ title, path }) => shareDoc(ledger, me, { title, path })}
  onOpenDoc={(doc) => open(doc.path)} />
```

Owner-only controls appear only when `me` is the owner and the callback is
passed. Errors thrown by a callback are shown inline in the panel.

## Tests

`core/people/*.test.ts` run with `npm run test:core`; the panel's tests are in
`tests-ui/people/` and run with `npm run test:ui`.
