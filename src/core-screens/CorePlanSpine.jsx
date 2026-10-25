import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDownIcon, CaretUpIcon, CrosshairIcon, GitBranchIcon } from "@phosphor-icons/react";
import { useCoreResource } from "./coreApi.js";
import { modelLabel } from "./CoreAgentConnect.jsx";
import { modelFamily } from "./CoreSpine.jsx";
import { getModelWorkerAsset } from "../modelWorkerAssets.js";
import "./CoreSpine.css";

// The Plan page for a real project. The main spine is the artery: every task of the project as a vertebra, with
// the people who own them along the top. Opening a person gives their own spine: their head on top, their tasks
// down the line, and the AI models working them running down it in parallel. Everything is read from this project's ledger; nothing is a sample.

// The robot drawings exist per vendor; a model we cannot place gets no robot rather than someone else's.
const ROBOT = { claude: "claude", gemini: "gemini", codex: "gpt" };
const FAMILY_LABEL = { claude: "Claude", gemini: "Gemini", codex: "Codex" };

const STAGE_TEXT = {
  "needs-test": "Waiting for a test",
  "test-proposed": "Test waiting for you",
  "test-approved": "Ready for a worker",
  "test-passes-already": "Test proves nothing",
  "waiting-for-jev": "Waiting for Jev",
  "jev-found-gaps": "Jev found gaps",
  "ready-to-claim": "Ready for a worker",
  building: "Being built",
  "review-diff": "Change waiting for you",
  "ready-to-merge": "Ready to merge",
  reopened: "Reopened",
  done: "Merged",
  draft: "Planned, not started",
};
const NEEDS_YOU = new Set(["test-proposed", "test-passes-already", "review-diff", "ready-to-merge"]);
const HALTED = new Set(["test-passes-already", "jev-found-gaps"]);

/** A planned task as a topic: its first clause, cut at a word, so a card reads as a heading. */
export function shortTitle(title, max = 44) {
  const first = String(title ?? "").split(/[:;.,\u2014\u2013(]| - /)[0].trim() || String(title ?? "").trim();
  if (first.length <= max) return first;
  return `${first.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/** The approved-to-be plan as groups of topic cards, before the ledger has any task. */
export function draftGroups(roadmap) {
  const phases = [];
  let n = 0;
  (roadmap?.phases ?? []).forEach((phase, index) => {
    const rows = (phase.tasks ?? []).map((t) => ({ owner: null, task: { id: t.key, label: `T${++n}`, title: shortTitle(t.title), stage: "draft", clauses: t.doneWhen ? [t.doneWhen] : [], dispatch: { model: t.owner }, draft: true } }));
    if (rows.length) phases.push({ id: phase.id, n: index + 1, title: phase.title, rows });
  });
  return phases;
}

const taskNumber = (id) => Number(String(id).replace(/\D/g, "")) || 0;

function liveWorker(task, agents) {
  return (agents ?? []).find((a) => a.role === "worker" && a.task === task.label && !a.revoked);
}

const isWorking = (task, worker) => task.stage === "building" && Boolean(worker) && !worker.quiet;

function robotOf(task, worker, state) {
  const model = worker?.model ?? task.dispatch?.model;
  const family = modelFamily(model);
  const slug = ROBOT[family.id];
  if (!slug) return null;
  return { family, model, label: `${FAMILY_LABEL[family.id]}${model ? ` (${modelLabel(model)})` : ""}`, src: getModelWorkerAsset(slug, state, "right") };
}

function Robot({ task, worker }) {
  const working = isWorking(task, worker);
  const state = working ? "running" : HALTED.has(task.stage) ? "dead-still" : "waiting";
  const robot = robotOf(task, worker, state);
  if (!robot) return null;
  const what = working ? "building this task now" : state === "dead-still" ? "stopped" : task.stage === "done" ? "finished" : "waiting";
  return (
    <>
      {task.stage === "done" && <span className="perimeter-success-trail complete" aria-hidden="true"><i className="trail-side trail-top" /><i className="trail-side trail-right" /><i className="trail-side trail-bottom" /><i className="trail-side trail-left" /></span>}
      <span className={`perimeter-worker ${working ? "running" : "stopped"}${task.stage === "done" ? " lap-finished" : ""}`} role="img" aria-label={`${robot.label}, ${what}`} title={`${robot.label} · ${what}`}>
        <img className="model-worker-image" src={robot.src} alt="" />
      </span>
    </>
  );
}

/** A person's picture (their own, from People) or, without one, their initial. */
function Face({ person, photo, big = false }) {
  const name = person.name || person.person || "?";
  return (
    <span className={`owner-avatar${photo ? " profile-avatar" : ""}${big ? " core-face-big" : ""}`}>
      {photo ? <img className="core-owner-photo" src={photo} alt="" /> : <span aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>}
    </span>
  );
}

function Owner({ person, via, onPerson }) {
  if (!person) return <span className="owner-badge core-plan-owner" title="No owner"><span className="owner-avatar"><span aria-hidden="true">?</span></span></span>;
  return (
    <button type="button" className="owner-badge core-plan-owner" title={`${via} ${person.name}: open their spine`} aria-label={`${via} ${person.name}: open their spine`} onClick={(event) => { event.stopPropagation(); onPerson(person.person); }}>
      <Face person={person} photo={person.photo} />
    </button>
  );
}

function Vertebra({ task, side, owner, via, agents, onOpen, onPerson, people, onAssign }) {
  const worker = liveWorker(task, agents);
  const model = worker?.model ?? task.dispatch?.model;
  const family = model ? modelFamily(model) : null;
  const diff = task.diffApproval ? 1 : 0;
  const shots = (task.proofs ?? []).length;
  const clauses = task.clauses?.length ? task.clauses : [];
  const total = Math.max(clauses.length, 1);
  const you = NEEDS_YOU.has(task.stage);
  const building = isWorking(task, worker);
  return (
    <article className={`plan-node core-vertebra${you ? " core-needs-you" : ""}${building ? " core-working" : ""}`} aria-label={`${task.label} ${task.title}`} data-stage={task.stage} data-side={side} tabIndex={0} onClick={() => onOpen(task)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(task); } }}>
      <Robot task={task} worker={worker} />
      <span className="node-header">
        <code>{task.label}</code>
        <span className="node-branch-ref" title={task.worktree?.branch ? `Branch: ${task.worktree.branch}` : "No branch yet"}><GitBranchIcon /></span>
        <strong>{task.title}</strong>
        {family && <span className="model-id-chip" title={model}>{family.name}</span>}
        <small className={building ? "core-working-text" : undefined}>{building ? "Building now" : STAGE_TEXT[task.stage] ?? String(task.stage)}</small>
        <span className={`proof-counter${diff ? " proven" : ""}`} title="Change approved by you"><GitBranchIcon />{diff ? total : 0}/{total}</span>
        <span className={`proof-counter${shots ? " proven" : ""}`} title="Proof items attached"><CrosshairIcon />{shots ? total : 0}/{total}</span>
        {!task.draft && <Owner person={owner} via={via} onPerson={onPerson} />}
      </span>
      {clauses.length > 0 && (
        <>
        <span className="proof-column-labels" aria-hidden="true"><span>DIFF</span><span>SHOT</span><span>TASK</span></span>
        <span className="node-items">
          {clauses.slice(0, 6).map((clause, i) => (
            <span className="node-item" key={i}>
              <span className={`tiny-check${diff ? " checked" : ""}`} aria-hidden="true" />
              <span className={`tiny-check${shots ? " checked" : ""}`} aria-hidden="true" />
              <code>{task.label}-{i + 1}</code>
              <span>{clause}</span>
            </span>
          ))}
          {clauses.length > 6 && <span className="core-muted">+{clauses.length - 6} more</span>}
        </span>
        </>
      )}
      {task.merged?.mergeCommit && <span className="core-vertebra-note">Merged at {String(task.merged.mergeCommit).slice(0, 12)}</span>}
      {people && task.stage !== "done" && (
        <label className="core-assign" onClick={(event) => event.stopPropagation()}>
          <span>Give to</span>
          <select aria-label={`Give ${task.label} to`} value={owner?.person ?? ""} onChange={(event) => event.target.value && onAssign(task, event.target.value)}>
            {!owner && <option value="">Pick a person</option>}
            {people.filter((p) => p.role !== "viewer").map((p) => <option key={p.person} value={p.person}>{p.name}</option>)}
          </select>
        </label>
      )}
      {task.waitingFor?.message && <span className="core-vertebra-note core-waiting">{task.waitingFor.message}</span>}
      {task.lastProgress && <span className="core-vertebra-note">{String(task.lastProgress.text ?? task.lastProgress).slice(0, 160)}</span>}
    </article>
  );
}

/** Roadmap phases with the ledger's tasks in them, and anything the roadmap does not place in a last group. */
export function groupByPhase(tasks, roadmap) {
  const byNumber = new Map(tasks.map((t) => [t.id, t]));
  const placed = new Set();
  const phases = [];
  (roadmap?.phases ?? []).forEach((phase, index) => {
    const rows = [];
    for (const item of phase.tasks ?? []) {
      const task = item.task ? byNumber.get(item.task) : null;
      if (task && !placed.has(task.id)) { placed.add(task.id); rows.push({ task, owner: item.owner && item.owner !== "unassigned" ? item.owner : null }); }
    }
    if (rows.length) phases.push({ id: phase.id, n: index + 1, title: phase.title, rows });
  });
  const rest = tasks.filter((t) => !placed.has(t.id));
  if (rest.length) phases.push({ id: phases.length ? "More" : "All", n: 0, title: phases.length ? "Not in a roadmap phase" : "Tasks", rows: rest.map((task) => ({ task, owner: null })) });
  return phases;
}

/** Everyone with a head on the spine: the roster, plus anyone a task names who is not on it. */
export function peopleOf({ tasks, groups, agents, people }) {
  const members = people?.view?.members ?? [];
  const photos = people?.photos ?? {};
  const fallback = people?.view?.owner?.person ?? null;
  const ownerOfTask = new Map();
  for (const g of groups) for (const r of g.rows) if (r.owner) ownerOfTask.set(r.task.id, r.owner);
  const byId = new Map(members.map((m) => [m.person, { person: m.person, name: m.name || m.person, role: m.role, photo: photos[m.person] ?? null, tasks: [] }]));
  const via = new Map();
  const ownerId = new Map();
  for (const task of tasks) {
    const worker = liveWorker(task, agents);
    const named = worker?.person ?? task.assignee ?? ownerOfTask.get(task.id);
    const id = named ?? fallback;
    via.set(task.id, named ? "Owner" : "Approves:");
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, { person: id, name: id, role: null, photo: photos[id] ?? null, tasks: [] });
    byId.get(id).tasks.push(task);
    ownerId.set(task.id, id);
  }
  for (const p of byId.values()) {
    p.merged = p.tasks.filter((t) => t.stage === "done").length;
    p.working = p.tasks.filter((t) => isWorking(t, liveWorker(t, agents))).length;
    p.needsYou = p.tasks.filter((t) => NEEDS_YOU.has(t.stage)).length;
  }
  return { list: [...byId.values()], byId, ownerId, via };
}

/** One line under a phase title: what its first topics are, as the demo's phase card says what the phase is for. */
function phaseLine(phase) {
  return phase.rows.slice(0, 2).map((r) => shortTitle(r.task.title, 40)).join(" · ");
}

/** The model on top of the whole spine, standing in for the one that orchestrates: the family doing most of the tasks. */
function headRobot(groups, agents) {
  const count = new Map();
  for (const g of groups) for (const r of g.rows) {
    const robot = robotOf(r.task, liveWorker(r.task, agents), "waiting");
    if (robot) count.set(robot.family.id, { robot, n: (count.get(robot.family.id)?.n ?? 0) + 1 });
  }
  return [...count.values()].sort((a, b) => b.n - a.n)[0]?.robot ?? null;
}

function SpineCanvas({ groups, model, agents, onWorkspace, onPerson, onAssign, runners, className = "" }) {
  let index = 0;
  const canvas = useRef(null);
  const head = headRobot(groups, agents);
  const page = (direction) => {
    const scroller = canvas.current?.closest(".workspace-stage-coordinate") ?? canvas.current?.closest(".plan-workspace");
    const box = scroller && scroller.scrollHeight > scroller.clientHeight ? scroller : null;
    (box ?? window).scrollBy({ top: direction * Math.max(620, (box?.clientHeight ?? window.innerHeight) * 0.88), behavior: "smooth" });
  };
  return (
    <div className={`plan-canvas ${className}`} ref={canvas}>
      <nav className="plan-page-controls" aria-label="Move through plan pages">
        <button type="button" onClick={() => page(-1)} aria-label="Move up one plan page"><CaretUpIcon weight="bold" /></button>
        <span>page</span>
        <button type="button" onClick={() => page(1)} aria-label="Move down one plan page"><CaretDownIcon weight="bold" /></button>
      </nav>
      <div className="spine-line" aria-hidden="true" />
      {groups.map((phase, phaseIndex) => (
        <div className="phase-row" key={phase.id}>
          {phaseIndex === 0 && head && <div className="head-orchestrator-perch"><span className="head-orchestrator-character" role="img" aria-label={`${head.label} heads this plan`} title={`${head.label} heads this plan`}><img className="model-worker-image" src={head.src} alt="" /></span></div>}
          <div className="phase-capsule" role="group" aria-label={`${phase.n ? `Phase ${phase.n}` : "Group"} ${phase.title}`}>
            <strong>{phase.n ? `P${phase.n} · ` : ""}{phase.title}</strong>
            <span>{phaseLine(phase)}</span>
            <small title={phase.rows[0]?.task.draft ? "Topics planned, none started" : "Tasks merged"}>{phase.rows.filter((r) => r.task.stage === "done").length}/{phase.rows.length}</small>
          </div>
          <div className="phase-nodes">
            {phase.rows.map(({ task }) => {
              const side = index++ % 2 === 0 ? "left" : "right";
              const worker = liveWorker(task, agents);
              const runner = runners && isWorking(task, worker) ? robotOf(task, worker, "running") : null;
              const card = <Vertebra task={task} side={side} owner={model.byId.get(model.ownerId.get(task.id))} via={model.via.get(task.id)} agents={agents} onOpen={(t) => onWorkspace?.(t.draft ? "planning" : "tasks")} onPerson={onPerson} people={model.assignable ? model.list : null} onAssign={onAssign} />;
              return (
                <div className={`single-node-row row-${side}`} key={task.id}>
                  {side === "left" ? <div className="node-slot node-left has-node">{card}</div> : <div className="node-spacer" />}
                  <div className="spine-junction" aria-hidden="true">
                    {runner && <span className="spine-runner" title={`${runner.label} · working down this spine`}><img src={runner.src} alt="" /></span>}
                  </div>
                  {side === "right" ? <div className="node-slot node-right has-node">{card}</div> : <div className="node-spacer" />}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PeopleStrip({ people, onPerson }) {
  return (
    <ul className="core-people-strip" aria-label="People on this project">
      {people.map((p) => (
        <li key={p.person}>
          <button type="button" className="core-person-card" onClick={() => onPerson(p.person)} aria-label={`Open ${p.name}'s spine`}>
            <Face person={p} photo={p.photo} />
            <span>
              <strong>{p.name}</strong>
              <small>{p.tasks.length ? `${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"} · ${p.working} working${p.needsYou ? ` · ${p.needsYou} need you` : ""}` : "No tasks yet"}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function CorePlanSpine({ onWorkspace, onCount }) {
  const tasks = useCoreResource("/tasks", { isEmpty: (d) => !d?.tasks?.length, pollMs: 4000 });
  const agents = useCoreResource("/agents", { pollMs: 4000 });
  const roadmap = useCoreResource("/planning/roadmap", { pollMs: 15000 });
  const people = useCoreResource("/people", { pollMs: 30000 });
  const [open, setOpen] = useState(null);
  const [problem, setProblem] = useState(null);
  const list = useMemo(() => (tasks.data?.tasks ? [...tasks.data.tasks].sort((a, b) => taskNumber(a.id) - taskNumber(b.id)) : []), [tasks.data]);
  const live = agents.data?.agents;
  const groups = useMemo(() => groupByPhase(list, roadmap.data), [list, roadmap.data]);
  const model = useMemo(() => peopleOf({ tasks: list, groups, agents: live, people: people.data }), [list, groups, live, people.data]);
  useEffect(() => { onCount?.(list.length); }, [list.length, onCount]);
  const drafts = useMemo(() => draftGroups(roadmap.data), [roadmap.data]);
  if (tasks.status === "empty" && drafts.length) {
    const topics = drafts.reduce((sum, g) => sum + g.rows.length, 0);
    const none = { list: [], byId: new Map(), ownerId: new Map(), via: new Map(), assignable: false };
    return (
      <section className="workspace plan-workspace core-plan-spine" aria-label="Plan spine">
        <p className="core-muted core-plan-count" role="status">Your plan as {topics} topic{topics === 1 ? "" : "s"}. Approve the plan in Deep planning and each topic becomes a task on this spine.</p>
        <button type="button" className="core-button" onClick={() => onWorkspace?.("planning")}>Open Deep planning</button>
        <SpineCanvas groups={drafts} model={none} agents={[]} onWorkspace={onWorkspace} onPerson={() => undefined} onAssign={() => undefined} />
      </section>
    );
  }
  if (tasks.status === "no-session" || tasks.status === "loading" || tasks.status === "empty") return null;
  if (tasks.status === "error") return <p role="alert" className="core-tasks-warn">The ledger could not be read, so the spine is not drawn. {tasks.error?.message} <button type="button" className="core-button" onClick={tasks.reload}>Try again</button></p>;

  // Only the owner gives tasks out, and only when there is someone to give them to.
  const assign = async (task, person) => {
    setProblem(null);
    try {
      await people.post("/people/assign", { task: task.id, person });
      await tasks.reload();
    } catch (error) {
      setProblem(error?.message || "That could not be saved.");
    }
  };
  const assignable = Boolean(people.data?.me && people.data?.view?.owner?.person === people.data.me && model.list.filter((p) => p.role !== "viewer").length > 1);
  const shared = { ...model, assignable };
  const person = open ? model.byId.get(open) : null;
  const done = list.filter((t) => t.stage === "done").length;
  const working = list.filter((t) => isWorking(t, liveWorker(t, live))).length;
  const warning = problem && <p role="alert" className="core-tasks-warn">{problem}</p>;

  if (person) {
    const mine = new Set(person.tasks.map((t) => t.id));
    const mineGroups = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => mine.has(r.task.id)) })).filter((g) => g.rows.length);
    return (
      <section className="workspace plan-workspace core-plan-spine" aria-label={`${person.name}'s spine`}>
        <header className="core-person-head">
          <button type="button" className="core-button" onClick={() => setOpen(null)}>← Main spine</button>
          <Face person={person} photo={person.photo} big />
          <h2>{person.name}</h2>
          <p className="core-muted" role="status">{person.role ? `${person.role} · ` : ""}{person.tasks.length} task{person.tasks.length === 1 ? "" : "s"} · {person.merged} merged · {person.working} model{person.working === 1 ? "" : "s"} working in parallel</p>
        </header>
        {warning}
        {person.tasks.length === 0
          ? <p className="core-empty" role="status">{person.name} has no tasks on this project yet.</p>
          : <SpineCanvas className="core-person-canvas" groups={mineGroups} model={shared} agents={live} onWorkspace={onWorkspace} onPerson={setOpen} onAssign={assign} runners />}
      </section>
    );
  }

  return (
    <section className="workspace plan-workspace core-plan-spine" aria-label="Plan spine">
      <PeopleStrip people={model.list} onPerson={setOpen} />
      <p className="core-muted core-plan-count" role="status">{done} of {list.length} merged · {working} working now · every card is a task on this project's ledger</p>
      {warning}
      <SpineCanvas groups={groups} model={shared} agents={live} onWorkspace={onWorkspace} onPerson={setOpen} onAssign={assign} />
    </section>
  );
}
