import { useEffect, useState } from "react";
import { useCoreResource } from "./coreApi.js";
import { modelLabel } from "./CoreAgentConnect.jsx";
import { deriveLiveWorkerState, providerOf, workerIdentityFor } from "./liveWorkerSpine.js";
import "./CoreSpine.css";

// The project's real tasks as one top-down spine: each task is a node, with six stations it passes
// through and the AI model that is working on it. Everything comes from the ledger through GET /tasks
// and GET /agents; nothing here is a sample.
const STATIONS = ["Test written", "Test approved", "Built", "Checked", "Diff approved", "Merged"];

// How many stations a task has finished, whose turn it is, and the plain words for where it stands.
const STAGES = {
  "needs-test": { done: 0, who: "worker", text: "Waiting for a test" },
  "test-proposed": { done: 1, who: "you", text: "Test waiting for your approval" },
  "test-approved": { done: 2, who: "worker", text: "Test approved, waiting for a worker" },
  "test-passes-already": { done: 2, who: "you", text: "The test already passes, so it proves nothing" },
  "waiting-for-jev": { done: 1, who: "jev", text: "Waiting for Jev to read the test" },
  "jev-found-gaps": { done: 1, who: "worker", text: "Jev found gaps in the test" },
  "ready-to-claim": { done: 2, who: "worker", text: "Ready for a worker to claim" },
  building: { done: 2, who: "model", text: "Being built" },
  "review-diff": { done: 3, who: "you", text: "Checked, waiting for your review of the change" },
  "ready-to-merge": { done: 5, who: "you", text: "Approved, waiting for you to merge" },
  reopened: { done: 0, who: "worker", text: "Sent back and reopened" },
  done: { done: 6, who: null, text: "Merged and done" },
};

// What the person does next on the Tasks screen, per stage; shown as a button on the Build page.
const NEXT_ACTION = {
  "needs-test": "Start a worker",
  "test-proposed": "Review the test",
  "test-approved": "Start a worker",
  "ready-to-claim": "Start a worker",
  "review-diff": "Review the change",
  "ready-to-merge": "Merge",
  reopened: "Start a worker",
};

/** The family a model belongs to, for its symbol. Anything unrecognised is shown as unknown, never guessed. */
export function modelFamily(model) {
  const text = String(model ?? "").replace(/^unverified:/, "").toLowerCase();
  if (/claude|sonnet|opus|haiku|fable/.test(text)) return { id: "claude", glyph: "C", name: "Claude" };
  if (/gemini/.test(text)) return { id: "gemini", glyph: "G", name: "Gemini" };
  if (/codex|gpt|openai|\bo\d/.test(text)) return { id: "codex", glyph: "X", name: "Codex" };
  return { id: "unknown", glyph: "?", name: "Unknown model" };
}

const taskNumber = (id) => Number(String(id).replace(/\D/g, "")) || 0;

function workerFor(task, agents) {
  return workerIdentityFor(task, agents);
}

function ModelSymbol({ worker, active }) {
  const provider = providerOf(worker);
  const family = provider === "unknown" ? modelFamily(worker.model) : { id: provider, glyph: provider === "codex" ? "X" : provider === "claude" ? "C" : "G", name: provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : "Gemini" };
  const mismatch = provider === "codex" && /claude|sonnet|opus|haiku/i.test(String(worker.model ?? ""));
  const label = `${worker.modelReported ? "Worker-reported provider: " : worker.modelRequested ? "Requested provider: " : ""}${family.name}${worker.model ? ` (${mismatch ? `configured ${modelLabel(worker.model)}; provider identity is Codex` : modelLabel(worker.model)})` : " · model unavailable"}`;
  return (
    <span className={`spine-model spine-model-${family.id}${active ? " spine-model-active" : ""}`} role="img" aria-label={`${label}${worker.modelConflict ? `; requested ${worker.requestedModel}, reported ${worker.reportedModel} (conflict)` : ""}${active ? ", working now" : ""}`} title={label}>
      <span className="spine-model-glyph" aria-hidden="true">{family.glyph}</span>
      {active && <span className="spine-model-orbit" aria-hidden="true"><i /></span>}
    </span>
  );
}

function LiveWork({ tasks, agents }) {
  const lanes = tasks.map((task) => {
    const worker = workerFor(task, agents);
    const live = deriveLiveWorkerState(task, worker);
    return { task, worker, live };
  }).filter(({ worker, live }) => worker && (live.animated || live.visible));
  if (!lanes.length) return null;
  return (
    <section className="spine-live-work" aria-label="Live work">
      <header><div><p className="spine-eyebrow">Observed now</p><h3>Live work</h3></div><p className="core-muted">Fresh worker-reported activity only</p></header>
      <ol className="spine-live-lanes">
        {lanes.map(({ task, worker, live }) => (
          <li key={task.id} className="spine-live-lane" data-live={live.animated ? "working" : "finished"}>
            <article>
              <ModelSymbol worker={worker} active={live.animated} />
              <div className="spine-live-copy"><p className="spine-id">{task.label} · {worker.id} · {providerOf(worker)} · {modelLabel(worker.model)}</p><h4>{task.title}</h4><p className="spine-live-action">{String(task.lastProgress?.text ?? task.lastProgress ?? live.label).slice(0, 200)}</p><p className="core-muted">{live.label} — {live.detail}{worker.modelConflict ? ` Requested ${worker.requestedModel}; worker reported ${worker.reportedModel}.` : ""}</p></div>
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Node({ task, agents, onAct }) {
  const stage = STAGES[task.stage] ?? { done: 0, who: null, text: String(task.stage ?? "Unknown") };
  const worker = task.stage === "done" ? null : workerFor(task, agents);
  const live = deriveLiveWorkerState(task, worker);
  const working = live.animated;
  // A task nobody has touched is one line; the full card is for work that is moving or waiting on you.
  const idle = !worker && task.stage !== "done" && stage.who !== "you" && !task.proofs?.length && !task.lastProgress;
  return (
    <li className={`spine-node spine-stage-${task.stage}${idle ? " spine-idle" : ""}`} data-stage={task.stage} data-working={working ? "true" : "false"}>
      <span className="spine-dot" aria-hidden="true" />
      <article aria-label={`${task.label} ${task.title}`}>
        <header>
          <span className="spine-id">{task.label}</span>
          <h3>{task.title}</h3>
          {worker && <ModelSymbol worker={worker} active={working} />}
        </header>
        <p className="spine-state">
          {live.state === "working" || (live.state === "waiting" && task.stage !== "building") ? stage.text : live.label}
          {stage.who === "you" && <strong className="spine-you"> · your turn</strong>}
          {worker && <span className="core-muted"> · {live.detail}</span>}
        </p>
        {!idle && <ol className="spine-stations" aria-label={`${task.label} progress`}>
          {STATIONS.map((name, i) => (
            <li key={name} data-state={i < stage.done ? "done" : i === stage.done && stage.who ? "next" : "todo"}>{name}</li>
          ))}
        </ol>}
        {onAct && NEXT_ACTION[task.stage] && <button type="button" className="core-button spine-act" onClick={() => onAct(task)}>{NEXT_ACTION[task.stage]}</button>}
        {task.lastProgress && <p className="spine-progress core-muted">Worker-reported activity: {String(task.lastProgress.text ?? task.lastProgress).slice(0, 200)}</p>}
        {!idle && <p className="spine-meta core-muted">
          {task.proofs?.length ? `${task.proofs.length} proof item${task.proofs.length === 1 ? "" : "s"}` : "No proof attached"}
          {task.merged?.mergeCommit ? ` · merged at ${String(task.merged.mergeCommit).slice(0, 12)}` : ""}
        </p>}
      </article>
    </li>
  );
}

const FILTERS = [
  ["all", "All", () => true],
  ["you", "Need you", (t, w) => STAGES[t.stage]?.who === "you" && t.stage !== "done"],
  ["working", "Working", (t, w) => deriveLiveWorkerState(t, w).animated],
  ["idle", "Not started", (t, w) => !w && t.stage !== "done" && STAGES[t.stage]?.who !== "you"],
  ["done", "Merged", (t) => t.stage === "done"],
];

export default function CoreSpine({ onWorkspace, onCount, actions = false, accountAll = false, pendingDispatches = {} }) {
  const [filter, setFilter] = useState("all");
  const [picked, setPicked] = useState(false);
  const tasks = useCoreResource("/tasks", { isEmpty: (data) => !data?.tasks?.length, pollMs: 4000 });
  const agents = useCoreResource("/agents", { pollMs: 4000 });
  const list = tasks.data?.tasks ? [...tasks.data.tasks].sort((a, b) => taskNumber(a.id) - taskNumber(b.id)) : [];
  useEffect(() => { onCount?.(list.length); }, [list.length, onCount]);
  if (tasks.status === "no-session") return null;
  const done = list.filter((t) => t.stage === "done").length;
  const workerOf = (t) => workerFor(t, agents.data?.agents);
  const counts = Object.fromEntries(FILTERS.map(([id, , test]) => [id, list.filter((t) => test(t, workerOf(t))).length]));
  // On the Build page the first thing to see is what is waiting on the person, until they pick a view.
  const view = actions && !accountAll && !picked && counts.you > 0 ? "you" : filter;
  const shown = list.filter((t) => FILTERS.find(([id]) => id === view)[2](t, workerOf(t)));
  const pending = Object.values(pendingDispatches).find((dispatch) => dispatch?.task && list.some((task) => task.id === dispatch.task && task.status !== "claimed" && task.status !== "done"));
  return (
    <section className="core-spine core-card" aria-labelledby="core-spine-title" data-state={tasks.status}>
      <header>
        <h3 id="core-spine-title">Task spine</h3>
        {list.length > 0 && <p className="core-muted" role="status">{done} of {list.length} merged · every row is read from this project's ledger</p>}
      </header>
      {pending && <p className="core-tasks-notice good" role="status">Worker setup is ready for {pending.task}. <button type="button" className="core-button" onClick={() => onWorkspace?.("tasks")}>Finish connecting worker</button> This returns to the exact set-up panel and does not start another worker.</p>}
      {tasks.status === "loading" && <p role="status" className="core-muted">Reading the ledger…</p>}
      {tasks.status === "error" && <p role="alert" className="core-tasks-warn">The ledger could not be read, so no tasks are shown. {tasks.error?.message} <button type="button" className="core-button" onClick={tasks.reload}>Try again</button></p>}
      {tasks.status === "empty" && (
        <p className="core-empty" role="status">
          No tasks on this project's ledger yet.{" "}
          {onWorkspace && <button type="button" className="core-button" onClick={() => onWorkspace("planning")}>Open Deep planning</button>}
        </p>
      )}
      {tasks.status === "ready" && <LiveWork tasks={list} agents={agents.data?.agents} />}
      {tasks.status === "ready" && list.length > 4 && (
        <div className="spine-filters" role="group" aria-label="Show tasks">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" className="core-button" aria-pressed={view === id} onClick={() => { setPicked(true); setFilter(id); }} disabled={id !== "all" && !counts[id]}>{label} <span className="core-muted">{counts[id]}</span></button>
          ))}
        </div>
      )}
      {tasks.status === "ready" && (
        <ol className="spine-list" aria-label="Tasks from the ledger">
          {shown.map((task) => <Node key={task.id} task={task} agents={agents.data?.agents} onAct={actions && onWorkspace ? () => onWorkspace("tasks") : undefined} />)}
        </ol>
      )}
    </section>
  );
}
