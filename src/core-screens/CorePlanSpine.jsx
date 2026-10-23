import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GitBranchIcon } from "@phosphor-icons/react";
import { useCoreResource } from "./coreApi.js";
import { modelLabel } from "./CoreAgentConnect.jsx";
import { modelFamily } from "./CoreSpine.jsx";
import { getModelWorkerAsset } from "../modelWorkerAssets.js";
import "./CoreSpine.css";

// The Plan page for a real project. The main spine is the artery: every task of the project as a vertebra, with
// the people who own them along the top. Opening a person gives their own spine: their head on top, their tasks
// down the line, the AI models working them running down it in parallel, and veins for every dependency (to their
// own tasks, and out to other people's). Everything is read from this project's ledger; nothing is a sample.

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
};
const NEEDS_YOU = new Set(["test-proposed", "test-passes-already", "review-diff", "ready-to-merge"]);
const HALTED = new Set(["test-passes-already", "jev-found-gaps"]);
// How far each vein bulges away from the spine, so several on one stretch do not lie on top of each other.
const LANES = [16, 25, 34, 43, 52];

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

function Vertebra({ task, side, owner, via, agents, onOpen, onPerson }) {
  const worker = liveWorker(task, agents);
  const model = worker?.model ?? task.dispatch?.model;
  const family = model ? modelFamily(model) : null;
  const diff = task.diffApproval ? 1 : 0;
  const shots = (task.proofs ?? []).length;
  const clauses = task.clauses?.length ? task.clauses : [];
  const you = NEEDS_YOU.has(task.stage);
  return (
    <article className={`plan-node core-vertebra${you ? " core-needs-you" : ""}`} aria-label={`${task.label} ${task.title}`} data-stage={task.stage} data-side={side} tabIndex={0} onClick={() => onOpen(task)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(task); } }}>
      <Robot task={task} worker={worker} />
      <span className="node-header">
        <code>{task.label}</code>
        <span className="node-branch-ref" title={task.worktree?.branch ? `Branch: ${task.worktree.branch}` : "No branch yet"}><GitBranchIcon /></span>
        <strong>{task.title}</strong>
        {family && <span className="model-id-chip" title={model}>{family.name}</span>}
        <small>{STAGE_TEXT[task.stage] ?? String(task.stage)}</small>
        <span className={`proof-counter${diff ? " proven" : ""}`} title="Change approved by you">DIFF {diff}/1</span>
        <span className={`proof-counter${shots ? " proven" : ""}`} title="Proof items attached">SHOT {shots}</span>
        <Owner person={owner} via={via} onPerson={onPerson} />
      </span>
      {clauses.length > 0 && (
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
      )}
      {task.merged?.mergeCommit && <span className="core-vertebra-note">Merged at {String(task.merged.mergeCommit).slice(0, 12)}</span>}
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

/** Every "this task waits for that one" the ledger knows, between tasks that exist, once each. */
export function dependencyEdges(tasks, roadmap) {
  const have = new Set(tasks.map((t) => t.id));
  const doneIds = new Set(tasks.filter((t) => t.stage === "done").map((t) => t.id));
  const seen = new Set();
  const edges = [];
  const add = (from, to) => {
    const key = `${from}>${to}`;
    if (from === to || !have.has(from) || !have.has(to) || seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, live: !doneIds.has(from) });
  };
  for (const phase of roadmap?.phases ?? []) for (const item of phase.tasks ?? []) if (item.task) for (const d of item.dependsOnTasks ?? []) add(String(d), item.task);
  for (const t of tasks) for (const d of t.waitingFor?.tasks ?? []) add(d, t.id);
  return edges;
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
    const named = worker?.person ?? ownerOfTask.get(task.id);
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

/** Draws the veins: one curve per dependency between two vertebrae, plus a stub out to other people's tasks. */
function Veins({ canvasRef, edges, stubs, onPerson, signature }) {
  const [geo, setGeo] = useState({ paths: [], chips: [] });
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const measure = () => {
      const box = canvas.getBoundingClientRect();
      const at = (id) => {
        const el = canvas.querySelector(`[data-junction="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, left: Boolean(el.closest(".single-node-row")?.classList.contains("row-left")) };
      };
      const paths = edges.flatMap((e, i) => {
        const a = at(e.from), b = at(e.to);
        if (!a || !b) return [];
        // Longer veins swing further out, so they read as separate vessels, never past the spine's own column.
        const bulge = LANES[i % LANES.length] + Math.min(Math.abs(b.y - a.y) / 25, 18);
        return [{ key: `${e.from}>${e.to}`, live: e.live, d: `M${a.x},${a.y} C${a.x + bulge},${a.y} ${b.x + bulge},${b.y} ${b.x},${b.y}` }];
      });
      const chips = stubs.flatMap((s, i) => {
        const a = at(s.inside);
        if (!a) return [];
        // The vein leaves on the side away from the card, out to a tag for the other person's task.
        const dir = a.left ? 1 : -1;
        const x = dir === 1 ? box.width - 96 : 96;
        const y = a.y + (i % 2 ? 14 : -14);
        return [{ ...s, key: `${s.inside}>${s.outside}`, x, y, d: `M${a.x},${a.y} C${a.x + dir * 160},${a.y} ${x - dir * 160},${y} ${x},${y}` }];
      });
      setGeo({ paths, chips });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [canvasRef, edges, stubs, signature]);
  return (
    <>
      <svg className="core-veins" aria-hidden="true" data-veins={geo.paths.length + geo.chips.length}>
        {geo.paths.map((p) => <path key={p.key} className={`core-vein${p.live ? " flowing" : ""}`} d={p.d} />)}
        {geo.chips.map((c) => <path key={c.key} className={`core-vein${c.live ? " flowing" : ""}`} d={c.d} />)}
      </svg>
      {geo.chips.map((c) => (
        <button key={c.key} type="button" className="core-vein-chip" style={{ top: c.y - 13, left: c.x - 74 }} onClick={() => onPerson(c.person)} title={`${c.label}: open ${c.name}'s spine`}>
          {c.outside} · {c.name}
        </button>
      ))}
    </>
  );
}

function SpineCanvas({ groups, edges, stubs, model, agents, onWorkspace, onPerson, runners, className = "" }) {
  const canvasRef = useRef(null);
  let index = 0;
  const signature = groups.map((g) => g.rows.map((r) => `${r.task.id}:${r.task.stage}`).join(",")).join("|");
  return (
    <div className={`plan-canvas ${className}`} ref={canvasRef}>
      <div className="spine-line" aria-hidden="true" />
      <Veins canvasRef={canvasRef} edges={edges} stubs={stubs} onPerson={onPerson} signature={signature} />
      {groups.map((phase) => (
        <div className="phase-row" key={phase.id}>
          <div className="phase-capsule" role="group" aria-label={`${phase.n ? `Phase ${phase.n}` : "Group"} ${phase.title}`}>
            <strong>{phase.n ? `P${phase.n} · ` : ""}{phase.title}</strong>
            <small>{phase.rows.filter((r) => r.task.stage === "done").length}/{phase.rows.length} merged</small>
          </div>
          <div className="phase-nodes">
            {phase.rows.map(({ task }) => {
              const side = index++ % 2 === 0 ? "left" : "right";
              const worker = liveWorker(task, agents);
              const runner = runners && isWorking(task, worker) ? robotOf(task, worker, "running") : null;
              const card = <Vertebra task={task} side={side} owner={model.byId.get(model.ownerId.get(task.id))} via={model.via.get(task.id)} agents={agents} onOpen={() => onWorkspace?.("tasks")} onPerson={onPerson} />;
              return (
                <div className={`single-node-row row-${side}`} key={task.id}>
                  {side === "left" ? <div className="node-slot node-left has-node">{card}</div> : <div className="node-spacer" />}
                  <div className="spine-junction" data-junction={task.id} aria-hidden="true">
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
  const list = useMemo(() => (tasks.data?.tasks ? [...tasks.data.tasks].sort((a, b) => taskNumber(a.id) - taskNumber(b.id)) : []), [tasks.data]);
  const live = agents.data?.agents;
  const groups = useMemo(() => groupByPhase(list, roadmap.data), [list, roadmap.data]);
  const edges = useMemo(() => dependencyEdges(list, roadmap.data), [list, roadmap.data]);
  const model = useMemo(() => peopleOf({ tasks: list, groups, agents: live, people: people.data }), [list, groups, live, people.data]);
  useEffect(() => { onCount?.(list.length); }, [list.length, onCount]);
  if (tasks.status === "no-session" || tasks.status === "loading" || tasks.status === "empty") return null;
  if (tasks.status === "error") return <p role="alert" className="core-tasks-warn">The ledger could not be read, so the spine is not drawn. {tasks.error?.message} <button type="button" className="core-button" onClick={tasks.reload}>Try again</button></p>;

  const person = open ? model.byId.get(open) : null;
  const done = list.filter((t) => t.stage === "done").length;
  const working = list.filter((t) => isWorking(t, liveWorker(t, live))).length;

  if (person) {
    const mine = new Set(person.tasks.map((t) => t.id));
    const mineGroups = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => mine.has(r.task.id)) })).filter((g) => g.rows.length);
    const own = edges.filter((e) => mine.has(e.from) && mine.has(e.to));
    const stubs = edges.filter((e) => mine.has(e.from) !== mine.has(e.to)).map((e) => {
      const inside = mine.has(e.from) ? e.from : e.to;
      const outside = mine.has(e.from) ? e.to : e.from;
      const other = model.byId.get(model.ownerId.get(outside));
      return { inside, outside, live: e.live, person: other?.person ?? "", name: other?.name ?? "", label: mine.has(e.from) ? `${outside} waits for ${inside}` : `${inside} waits for ${outside}` };
    }).filter((s) => s.person && s.person !== person.person);
    return (
      <section className="workspace plan-workspace core-plan-spine" aria-label={`${person.name}'s spine`}>
        <header className="core-person-head">
          <button type="button" className="core-button" onClick={() => setOpen(null)}>← Main spine</button>
          <Face person={person} photo={person.photo} big />
          <h2>{person.name}</h2>
          <p className="core-muted" role="status">{person.role ? `${person.role} · ` : ""}{person.tasks.length} task{person.tasks.length === 1 ? "" : "s"} · {person.merged} merged · {person.working} model{person.working === 1 ? "" : "s"} working in parallel{stubs.length ? ` · ${stubs.length} vein${stubs.length === 1 ? "" : "s"} out to other people` : ""}</p>
        </header>
        {person.tasks.length === 0
          ? <p className="core-empty" role="status">{person.name} has no tasks on this project yet.</p>
          : <SpineCanvas className="core-person-canvas" groups={mineGroups} edges={own} stubs={stubs} model={model} agents={live} onWorkspace={onWorkspace} onPerson={setOpen} runners />}
      </section>
    );
  }

  return (
    <section className="workspace plan-workspace core-plan-spine" aria-label="Plan spine">
      <PeopleStrip people={model.list} onPerson={setOpen} />
      <p className="core-muted core-plan-count" role="status">{done} of {list.length} merged · {working} working now · {edges.length} dependenc{edges.length === 1 ? "y" : "ies"} · every card is a task on this project's ledger</p>
      <SpineCanvas groups={groups} edges={edges} stubs={[]} model={model} agents={live} onWorkspace={onWorkspace} onPerson={setOpen} />
    </section>
  );
}
