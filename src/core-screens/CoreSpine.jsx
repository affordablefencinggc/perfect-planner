import { useEffect, useState } from "react";
import { useCoreResource } from "./coreApi.js";
import { modelLabel } from "./CoreAgentConnect.jsx";
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
  const live = (agents ?? []).find((a) => a.role === "worker" && a.task === task.label && !a.revoked);
  const model = live?.model ?? task.dispatch?.model;
  return model || live ? { name: live?.name, model, quiet: Boolean(live?.quiet) } : null;
}

function ModelSymbol({ worker, active }) {
  const family = modelFamily(worker.model);
  const label = `${family.name}${worker.model ? ` (${modelLabel(worker.model)})` : ""}`;
  return (
    <span className={`spine-model spine-model-${family.id}${active ? " spine-model-active" : ""}`} role="img" aria-label={`${label}${active ? ", working now" : ""}`} title={label}>
      <span className="spine-model-glyph" aria-hidden="true">{family.glyph}</span>
      {active && <span className="spine-model-orbit" aria-hidden="true"><i /></span>}
    </span>
  );
}

function Node({ task, agents }) {
  const stage = STAGES[task.stage] ?? { done: 0, who: null, text: String(task.stage ?? "Unknown") };
  const worker = task.stage === "done" ? null : workerFor(task, agents);
  const working = task.stage === "building" && worker && !worker.quiet;
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
          {stage.text}
          {stage.who === "you" && <strong className="spine-you"> · your turn</strong>}
          {worker?.quiet && task.stage === "building" && <span className="core-muted"> · its worker has not been heard from lately</span>}
        </p>
        {!idle && <ol className="spine-stations" aria-label={`${task.label} progress`}>
          {STATIONS.map((name, i) => (
            <li key={name} data-state={i < stage.done ? "done" : i === stage.done && stage.who ? "next" : "todo"}>{name}</li>
          ))}
        </ol>}
        {task.lastProgress && <p className="spine-progress core-muted">{String(task.lastProgress.text ?? task.lastProgress).slice(0, 200)}</p>}
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
  ["working", "Working", (t, w) => Boolean(w) && t.stage !== "done"],
  ["idle", "Not started", (t, w) => !w && t.stage !== "done" && STAGES[t.stage]?.who !== "you"],
  ["done", "Merged", (t) => t.stage === "done"],
];

export default function CoreSpine({ onWorkspace, onCount }) {
  const [filter, setFilter] = useState("all");
  const tasks = useCoreResource("/tasks", { isEmpty: (data) => !data?.tasks?.length, pollMs: 4000 });
  const agents = useCoreResource("/agents", { pollMs: 4000 });
  if (tasks.status === "no-session") return null;
  const list = tasks.data?.tasks ? [...tasks.data.tasks].sort((a, b) => taskNumber(a.id) - taskNumber(b.id)) : [];
  const done = list.filter((t) => t.stage === "done").length;
  useEffect(() => { onCount?.(list.length); }, [list.length, onCount]);
  const workerOf = (t) => workerFor(t, agents.data?.agents);
  const counts = Object.fromEntries(FILTERS.map(([id, , test]) => [id, list.filter((t) => test(t, workerOf(t))).length]));
  const shown = list.filter((t) => FILTERS.find(([id]) => id === filter)[2](t, workerOf(t)));
  return (
    <section className="core-spine core-card" aria-labelledby="core-spine-title" data-state={tasks.status}>
      <header>
        <h3 id="core-spine-title">Task spine</h3>
        {list.length > 0 && <p className="core-muted" role="status">{done} of {list.length} merged · every row is read from this project's ledger</p>}
      </header>
      {tasks.status === "loading" && <p role="status" className="core-muted">Reading the ledger…</p>}
      {tasks.status === "error" && <p role="alert" className="core-tasks-warn">The ledger could not be read, so no tasks are shown. {tasks.error?.message} <button type="button" className="core-button" onClick={tasks.reload}>Try again</button></p>}
      {tasks.status === "empty" && (
        <p className="core-empty" role="status">
          No tasks on this project's ledger yet.{" "}
          {onWorkspace && <button type="button" className="core-button" onClick={() => onWorkspace("planning")}>Open Deep planning</button>}
        </p>
      )}
      {tasks.status === "ready" && list.length > 4 && (
        <div className="spine-filters" role="group" aria-label="Show tasks">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" className="core-button" aria-pressed={filter === id} onClick={() => setFilter(id)} disabled={id !== "all" && !counts[id]}>{label} <span className="core-muted">{counts[id]}</span></button>
          ))}
        </div>
      )}
      {tasks.status === "ready" && (
        <ol className="spine-list" aria-label="Tasks from the ledger">
          {shown.map((task) => <Node key={task.id} task={task} agents={agents.data?.agents} />)}
        </ol>
      )}
    </section>
  );
}
