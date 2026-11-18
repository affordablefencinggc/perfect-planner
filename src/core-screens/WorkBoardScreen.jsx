import { ArrowClockwiseIcon, ArrowRightIcon, CheckCircleIcon, CopyIcon, GitBranchIcon, ShieldCheckIcon, UserIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AdvancedOnly, CoreScreen, useAdvanced } from "./CoreScreen.jsx";
import { coreGet, corePost, useCoreResource } from "./coreApi.js";
import "./WorkBoardScreen.css";

// One board for every plan. The columns are the real workflow stages, the cards are the
// ledger's tasks, and the rail above them is where failures live: a test that failed, a
// worker that went quiet, a dependency that never landed, a plan that changed underneath.
// Nothing here is a second store; every card is a fold over the same signed ledger the
// Tasks screen reads.

const HEALTH_LABEL = {
  working: "Working",
  finished: "Finished",
  quiet: "Quiet",
  stalled: "Stalled",
  failed: "Test failed",
  blocked: "Blocked",
  review: "Needs review",
  ship: "Ready to ship",
  ready: "Ready to claim",
  done: "Shipped",
  idle: "Not started",
};

const LEVEL_ORDER = { stop: 0, risk: 1, info: 2 };

/** One row per kind of problem, with the tasks that have it. Four identical "plan changed" rows
 *  used to push the board below the fold; the facts are the same, so they share a row. */
function groupedAttention(items) {
  const order = [...items].sort((left, right) => LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level]);
  const groups = new Map();
  for (const item of order) {
    const group = groups.get(item.code);
    if (group) group.tasks.push(item);
    else groups.set(item.code, { code: item.code, level: item.level, action: item.action, sample: item, tasks: [item] });
  }
  return [...groups.values()].map((group) => {
    const many = group.tasks.length > 1;
    const message = many && group.code === "plan-changed"
      ? `The plan was approved after ${group.tasks.length} open tasks were created.`
      : many
        ? `${group.tasks.length} tasks: ${group.sample.message.replace(/^T-[\d.a]+\s*/, "")}`
        : group.sample.message;
    return { ...group, message, project: group.sample.project };
  });
}

function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function ModelBadge({ task }) {
  if (!task.model) return <span className="wb-model wb-model-none" title="No model reported yet">no model</span>;
  const family = /codex|openai|gpt|^o\d/i.test(task.model) ? "codex" : /claude|sonnet|opus|haiku/i.test(task.model) ? "claude" : /gemini/i.test(task.model) ? "gemini" : "unknown";
  return (
    <span className={`wb-model wb-model-${family}${task.modelConflict ? " wb-model-conflict" : ""}`} title={task.modelConflict ? `Requested ${task.requestedModel}; reported ${task.reportedModel}` : task.model}>
      <span aria-hidden="true">{family === "codex" ? "◆" : family === "claude" ? "✳" : family === "gemini" ? "✦" : "•"}</span>
      {task.model}
      {task.modelConflict && <strong> conflict</strong>}
    </span>
  );
}

function Card({ task, onOpen, activeProject }) {
  const attentionStops = task.attention.filter((item) => item.level === "stop").length;
  const attentionRisks = task.attention.filter((item) => item.level === "risk").length;
  return (
    <button type="button" className={`wb-card wb-health-${task.health}`} onClick={() => onOpen(task)} aria-label={`${task.label}: ${task.title}. ${HEALTH_LABEL[task.health]}.`}>
      <span className="wb-card-top">
        <span className="wb-id">{task.label}</span>
        <span className={`wb-health wb-health-${task.health}`}>{HEALTH_LABEL[task.health]}</span>
      </span>
      <span className="wb-title">{task.title}</span>
      <span className="wb-meta">
        <span className="wb-project">{task.project === activeProject ? task.projectLabel : `${task.projectLabel} · ${task.project}`}</span>
        {task.phase && <span className="wb-phase">{task.phase}</span>}
        {task.assignee && <span className="wb-assignee"><UserIcon aria-hidden="true" />{task.assignee}</span>}
      </span>
      <span className="wb-card-foot">
        <ModelBadge task={task} />
        <span className="wb-facts">
          {task.check && <span className={task.check.passed ? "wb-check ok" : "wb-check bad"}>{task.check.passed ? "check passed" : "check failed"}</span>}
          {task.proofs > 0 && <span className="wb-proofs">{task.proofs} proof{task.proofs === 1 ? "" : "s"}</span>}
          {task.progressAgeMs != null && <span className="wb-age">progress {ago(task.progressAgeMs)} ago</span>}
        </span>
      </span>
      {(attentionStops > 0 || attentionRisks > 0) && (
        <span className="wb-attention-dots" aria-hidden="true">
          {attentionStops > 0 && <i className="stop">{attentionStops}</i>}
          {attentionRisks > 0 && <i className="risk">{attentionRisks}</i>}
        </span>
      )}
      {task.waitingFor && <span className="wb-waiting">{task.waitingFor}</span>}
    </button>
  );
}

function AttentionRail({ items, onOpen, onProject }) {
  if (!items.length) {
    return (
      <div className="wb-rail wb-rail-clear" role="status">
        <CheckCircleIcon weight="fill" aria-hidden="true" />
        <div><strong>Nothing needs a decision right now.</strong><p>No failed checks, stalled workers, broken dependencies or changed plans are recorded for this project.</p></div>
      </div>
    );
  }
  const groups = groupedAttention(items);
  return (
    <section className="wb-rail" aria-label="Needs attention">
      <header>
        <WarningCircleIcon weight="fill" aria-hidden="true" />
        <div><strong>{items.length} thing{items.length === 1 ? "" : "s"} need{items.length === 1 ? "s" : ""} a person</strong><p>Every one is derived from the ledger; nothing here is a guess.</p></div>
      </header>
      <ul>
        {groups.map((group) => (
          <li key={group.code} data-level={group.level}>
            <span className="wb-rail-task">{group.code}</span>
            <div>
              <strong>{group.message}</strong>
              <p>{group.action}</p>
            </div>
            {group.code === "token-budget" ? (
              <button type="button" className="core-button" onClick={onProject}>Raise the cap</button>
            ) : (
              <div className="wb-rail-actions" aria-label={`Open ${group.tasks.map((item) => item.task).join(", ")}`}>
                {group.tasks.slice(0, 4).map((item) => (
                  <button type="button" className="core-button wb-rail-open" key={`${item.task}-${item.code}`} onClick={() => onOpen({ id: item.task, label: item.task, title: item.title, project: item.project })} disabled={item.task === "project"}>{item.task}</button>
                ))}
                {group.tasks.length > 4 && <span className="wb-rail-more">+{group.tasks.length - 4}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Guards({ data }) {
  const guards = data.guards;
  const rows = [
    ["Ledger chain", guards.ledger.ok ? `verified · ${guards.ledger.entries} entries` : `BROKEN at ${guards.ledger.firstBad ?? "an unknown entry"}`, guards.ledger.ok ? true : null],
    ["Pre-push secret scan", guards.secretScan === "installed" ? "installed in the repo" : guards.secretScan === "opted-out" ? "switched off by a person" : guards.secretScan === "not-installed" ? "not installed" : "not checked yet", guards.secretScan === "installed" ? true : guards.secretScan === "unknown" ? null : false],
    ["Test containment", guards.containment === "contained" ? "contained" : "not contained on this OS", guards.containment === "contained"],
    ["Malware scan", "not assessed — no scanner is connected", null],
    ["Dependency audit", "not run — no vulnerability gate exists", null],
  ];
  return (
    <section className="wb-guards" aria-label="Shipping guards">
      <header><ShieldCheckIcon aria-hidden="true" /><div><strong>Shipping guards</strong><p>What would have to be true before this is called shipped.</p></div></header>
      <dl>
        {rows.map(([label, value, ok]) => (
          <div key={label} data-ok={ok === null ? "unknown" : ok ? "yes" : "no"}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Budget({ data, post, onSaved }) {
  const [value, setValue] = useState(data.budget.tokenBudget == null ? "" : String(data.budget.tokenBudget));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { setValue(data.budget.tokenBudget == null ? "" : String(data.budget.tokenBudget)); }, [data.budget.tokenBudget]);
  const save = async (event) => {
    event.preventDefault();
    setBusy(true); setError(""); setNote("");
    try {
      const tokenBudget = value.trim() === "" ? null : Number(value);
      if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) throw new Error("Give a whole number of tokens, or leave it empty for no cap.");
      await post("/tasks/settings", { tokenBudget });
      setNote(tokenBudget === null ? "Token cap removed." : "Token cap saved. New workers stop at it.");
      onSaved?.();
    } catch (failure) {
      setError(failure?.message ?? "The cap could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="wb-budget" onSubmit={save}>
      <label htmlFor="wb-budget-input">Token cap for new workers</label>
      <input id="wb-budget-input" inputMode="numeric" placeholder="no cap" value={value} onChange={(event) => setValue(event.target.value)} />
      <button type="submit" className="core-button" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      <span className="wb-budget-state">
        {data.budget.state === "uncapped" ? "No cap" : `${data.budget.tokensSpent.toLocaleString()} of ${data.budget.tokenBudget.toLocaleString()} reported tokens`}
        {data.budget.state === "reached" && <strong className="wb-budget-stop"> · reached, new workers refused</strong>}
      </span>
      {note && <span className="wb-budget-note" role="status">{note}</span>}
      {error && <span className="wb-budget-error" role="alert">{error}</span>}
    </form>
  );
}

function ReceiptDrawer({ task, project, columnLabel, onClose, onWorkspace, onChanged }) {
  const advanced = useAdvanced();
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [to, setTo] = useState("");
  const [people, setPeople] = useState([]);
  const [handoverNote, setHandoverNote] = useState("");
  const [handoverError, setHandoverError] = useState("");
  const drawerRef = useRef(null);
  const readOnlyProject = task.project !== project;

  useEffect(() => {
    let live = true;
    setReceipt(null); setError("");
    coreGet(`/tasks/${task.id}/receipt`, project).then(
      (value) => { if (live) setReceipt(value); },
      (failure) => { if (live) setError(failure?.message ?? "The receipt could not be read."); },
    );
    return () => { live = false; };
  }, [task.id, project]);

  useEffect(() => {
    let live = true;
    coreGet("/people", project).then(
      (value) => { if (live) setPeople(Array.isArray(value?.view?.members) ? value.view.members : []); },
      () => { if (live) setPeople([]); },
    );
    return () => { live = false; };
  }, [project]);

  // The drawer is portalled to the body: a transformed ancestor (.workspace-stage) would
  // otherwise capture position:fixed and push it 192px down, under the topbar on phone.
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey);
    const first = drawerRef.current?.querySelector("button");
    first?.focus?.();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!receipt) return;
    setNextAction((current) => current || receipt.nextAction || "");
  }, [receipt]);

  const copy = async () => {
    if (!receipt?.text) return;
    try { await navigator.clipboard.writeText(receipt.text); setHandoverNote("Receipt copied."); }
    catch { setHandoverNote("The browser refused the clipboard. Select the receipt text and copy it."); }
  };

  const handOver = async (event) => {
    event.preventDefault();
    setBusy(true); setHandoverError(""); setHandoverNote("");
    try {
      await corePost(`/tasks/${task.id}/handover`, project, { note, nextAction, ...(to.trim() ? { to: to.trim() } : {}) });
      setHandoverNote("Handover recorded. The claim is released and the worktree is kept.");
      setNote(""); setTo("");
      onChanged?.();
      const fresh = await coreGet(`/tasks/${task.id}/receipt`, project);
      setReceipt(fresh);
    } catch (failure) {
      setHandoverError(failure?.message ?? "The handover could not be recorded.");
    } finally {
      setBusy(false);
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="wb-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="wb-drawer" role="dialog" aria-modal="true" aria-labelledby="wb-drawer-title" ref={drawerRef}>
      <header>
        <div>
          <span className="wb-id">{task.label ?? task.id}</span>
          <h3 id="wb-drawer-title">{task.title}</h3>
          <p className="core-muted">{task.projectLabel ?? task.project} · {columnLabel ?? task.stage} · attempt {task.attempt ?? 1}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close task details"><XIcon aria-hidden="true" /></button>
      </header>

      {error && <p role="alert" className="core-tasks-warn">{error}</p>}
      {!receipt && !error && <p className="core-muted" role="status">Reading the receipt…</p>}

      {receipt && (
        <>
          <section className="wb-receipt-facts" aria-label="Task facts">
            <dl>
              <div><dt>Worker</dt><dd>{receipt.task.owner ?? "none"}</dd></div>
              <div><dt>Assignee</dt><dd>{receipt.task.assignee ?? "nobody"}</dd></div>
              <div><dt>Model</dt><dd>{receipt.task.model ?? "not reported"}{receipt.task.modelConflict ? " (conflict)" : ""}</dd></div>
              <div><dt>Branch</dt><dd>{receipt.work.branch ?? "no worktree yet"}</dd></div>
              <div><dt>Claims</dt><dd>{receipt.work.claims.length ? receipt.work.claims.join(", ") : "none"}</dd></div>
              <div><dt>Test</dt><dd>{receipt.checks.test ?? "not written"}</dd></div>
              <div><dt>Check</dt><dd>{receipt.checks.check ? (receipt.checks.check.passed ? "passed" : "FAILED") : "not run"}</dd></div>
              <div><dt>Reported usage</dt><dd>{receipt.usage.inputTokens.toLocaleString()} in / {receipt.usage.outputTokens.toLocaleString()} out · ${receipt.usage.usd.toFixed(4)}</dd></div>
              <div><dt>Token cap</dt><dd>{receipt.usage.tokenBudget == null ? "no cap" : `${receipt.usage.tokensSpent.toLocaleString()} of ${receipt.usage.tokenBudget.toLocaleString()}`}</dd></div>
              <div><dt>Plan</dt><dd>{receipt.plan.approved ? `${receipt.plan.latest}${receipt.plan.changedSince ? " (changed since this task)" : ""}` : "not approved"}</dd></div>
            </dl>
          </section>

          <section className="wb-receipt-risks" aria-label="Open risks">
            <h4>Open risks</h4>
            {receipt.openRisks.length ? <ul>{receipt.openRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p className="core-muted">None recorded.</p>}
            <p className="wb-next"><strong>Next action:</strong> {receipt.nextAction}</p>
          </section>

          <section className="wb-receipt-text" aria-label="Handover receipt">
            <header>
              <h4>Handover receipt</h4>
              <button type="button" className="core-button" onClick={copy}><CopyIcon aria-hidden="true" /> Copy receipt</button>
            </header>
            <pre tabIndex={0}>{receipt.text}</pre>
            <AdvancedOnly as="p" className="core-muted">receipt {receipt.digest.slice(0, 24)}</AdvancedOnly>
          </section>

          {readOnlyProject ? (
            <p className="wb-readonly-project" role="note">This task belongs to <strong>{task.project}</strong>. Open that project to act on it; the board is showing it read-only.</p>
          ) : (
            <form className="wb-handover" onSubmit={handOver}>
              <h4>Hand this task over</h4>
              <p className="core-muted">The worker's token stops, the claim is released, and the worktree, branch and commits are kept for whoever picks it up.</p>
              <label>What the next person must know
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="What is done, what is half-done, what to avoid." />
              </label>
              <label>Next concrete action
                <input value={nextAction} onChange={(event) => setNextAction(event.target.value)} placeholder="Read src/store.js, then finish the search path." />
              </label>
              <label>Give it to
                <select value={to} onChange={(event) => setTo(event.target.value)}>
                  <option value="">Back to the pool (nobody)</option>
                  {people.map((member) => (
                    <option key={member.person} value={member.person}>{member.name} · {member.role}</option>
                  ))}
                </select>
              </label>
              <div className="wb-handover-actions">
                <button type="submit" className="core-button primary" disabled={busy}>{busy ? "Recording…" : "Record handover"}</button>
                <button type="button" className="core-button" onClick={() => onWorkspace("tasks")}><ArrowRightIcon aria-hidden="true" /> Open in Tasks</button>
              </div>
              {handoverNote && <p role="status" className="wb-handover-note">{handoverNote}</p>}
              {handoverError && <p role="alert" className="wb-handover-error">{handoverError}</p>}
            </form>
          )}
          {advanced && receipt.history.length > 0 && (
            <section className="wb-history" aria-label="Recent ledger entries">
              <h4>Recent ledger</h4>
              <ol>{receipt.history.map((entry) => <li key={entry.n}><code>{entry.n}</code> {entry.type}: {entry.summary}</li>)}</ol>
            </section>
          )}
        </>
      )}
      </aside>
    </>,
    document.body,
  );
}

export default function WorkBoardScreen({ onWorkspace }) {
  const resource = useCoreResource("/board", { pollMs: 3000, isEmpty: (data) => !data || !Array.isArray(data.tasks) });
  const [open, setOpen] = useState(null);
  const [phaseFilter, setPhaseFilter] = useState("all");
  const data = resource.data;
  const project = resource.project;

  const phases = useMemo(() => {
    const seen = new Set();
    for (const task of data?.tasks ?? []) if (task.phase) seen.add(task.phase);
    return [...seen].sort();
  }, [data]);

  const tasks = useMemo(() => {
    if (!data) return [];
    return phaseFilter === "all" ? data.tasks : data.tasks.filter((task) => task.phase === phaseFilter);
  }, [data, phaseFilter]);

  const columns = data?.columns ?? [];
  const byColumn = useMemo(() => {
    const map = new Map(columns.map((column) => [column.id, []]));
    for (const task of tasks) map.get(task.column)?.push(task);
    return map;
  }, [tasks, columns]);

  const openTask = (task) => {
    const full = data?.tasks.find((item) => item.id === task.id && item.project === task.project) ?? task;
    setOpen(full);
  };

  const goToBudget = () => {
    const input = document.getElementById("wb-budget-input");
    input?.scrollIntoView({ block: "center", behavior: "smooth" });
    input?.focus?.();
  };

  return (
    <CoreScreen
      id="board"
      title="Work board"
      purpose="Every plan's tasks on one board: what is building, what is broken, what needs you, and what is ready to ship."
      resource={resource}
      actions={<button type="button" className="core-button" onClick={resource.reload}><ArrowClockwiseIcon aria-hidden="true" /> Refresh</button>}
      empty="No tasks yet. Approve a plan or add a task, and it appears here as a card."
    >
      {data && (
        <div className="wb-shell">
          <div className="wb-totals" role="status" aria-label="Board totals">
            <span><strong>{data.totals.working}</strong> working</span>
            <span><strong>{data.totals.needsYou}</strong> in review</span>
            <span className={data.totals.attention ? "wb-total-bad" : ""}><strong>{data.totals.attention}</strong> need a decision</span>
            <span><strong>{data.totals.blocked}</strong> blocked</span>
            <span><strong>{data.totals.ship}</strong> ready to ship</span>
            <span><strong>{data.totals.done}</strong> shipped</span>
            <span className={data.totals.failed ? "wb-total-bad" : ""}><strong>{data.totals.failed}</strong> failed check{data.totals.failed === 1 ? "" : "s"}</span>
            <span className={data.totals.stalled ? "wb-total-bad" : ""}><strong>{data.totals.stalled}</strong> stalled</span>
          </div>

          {phases.length > 1 && (
            <div className="wb-projects" role="group" aria-label="Filter by phase">
              <button type="button" className={phaseFilter === "all" ? "active" : ""} onClick={() => setPhaseFilter("all")}>All phases</button>
              {phases.map((phase) => (
                <button type="button" key={phase} className={phaseFilter === phase ? "active" : ""} onClick={() => setPhaseFilter(phase)}>
                  {phase} <small>{data.tasks.filter((task) => task.phase === phase).length}</small>
                </button>
              ))}
            </div>
          )}

          <AttentionRail items={data.attention} onOpen={openTask} onProject={goToBudget} />

          <div className="wb-columns" aria-label="Workflow columns">
            {columns.map((column) => {
              const items = byColumn.get(column.id) ?? [];
              return (
                <section className={`wb-column wb-column-${column.id}`} key={column.id} aria-labelledby={`wb-col-${column.id}`}>
                  <header>
                    <h3 id={`wb-col-${column.id}`}>{column.label} <span>{items.length}</span></h3>
                    <p>{column.hint}</p>
                  </header>
                  <div className="wb-column-cards">
                    {items.length === 0 && <p className="wb-column-empty">Nothing here.</p>}
                    {items.map((task) => <Card key={`${task.project}-${task.id}`} task={task} onOpen={openTask} activeProject={project} />)}
                  </div>
                </section>
              );
            })}
          </div>

          <Guards data={data} />

          <Budget data={data} post={resource.post} onSaved={resource.reload} />

          <p className="wb-plan-line core-muted">
            {data.plan.approved ? `Plan ${data.plan.latest} approved; ${data.plan.count} approval${data.plan.count === 1 ? "" : "s"} on the ledger.` : "No approved plan yet: the board still shows every task that exists."}
            {data.projects.length > 1 && ` Other projects on this computer: ${data.projects.filter((item) => !item.active).map((item) => `${item.label} (${item.tasks} task${item.tasks === 1 ? "" : "s"}${item.readable ? "" : ", unreadable"})`).join(", ")}. Open one to act on it.`}
          </p>
        </div>
      )}
      {open && (
        <ReceiptDrawer
          task={open}
          project={project}
          columnLabel={columns.find((column) => column.id === open.column)?.label}
          onClose={() => setOpen(null)}
          onWorkspace={onWorkspace}
          onChanged={resource.reload}
        />
      )}
    </CoreScreen>
  );
}
