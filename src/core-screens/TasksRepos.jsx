import { useState } from "react";
import { useCoreResource } from "./coreApi.js";

// Several repos in one project (core/repos), the merge-together button for a plan task split over them, and
// what the work cost (core/cost). Every dollar figure says where it came from; a task that reported nothing
// shows no cost, never $0.
const usd = (n) => `$${n >= 1 ? n.toFixed(2) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;
const kilo = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function useForm(submit) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { await submit(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return { error, busy, run };
}

export function RepoBar({ repos, onAdd, onRemove }) {
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const form = useForm(async () => { await onAdd(name.trim(), root.trim()); setName(""); setRoot(""); });
  return (
    <section className="core-card core-tasks-repos" aria-label="Repos in this project">
      <ul>
        {repos.map((repo) => (
          <li key={repo.name}>
            <strong>{repo.name}</strong> {repo.ok ? <code>{repo.root}</code> : <span className="core-tasks-warn">{repo.reason}</span>}
            {repo.worktrees > 0 && <span className="core-muted"> · {repo.worktrees} worktree{repo.worktrees === 1 ? "" : "s"}</span>}
            {repo.name !== "main" && <button type="button" className="core-button" onClick={() => onRemove(repo.name)} aria-label={`Remove repo ${repo.name}`}>Remove</button>}
          </li>
        ))}
      </ul>
      <details>
        <summary>Add another repo to this project</summary>
        <form onSubmit={form.run}>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="web" autoComplete="off" /></label>
          <label>Git folder<input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C:\repos\web" autoComplete="off" /></label>
          <button type="submit" className="core-button primary" disabled={!name.trim() || !root.trim() || form.busy}>Add repo</button>
          {form.error && <p className="core-tasks-warn" role="alert">{form.error.message}</p>}
        </form>
      </details>
    </section>
  );
}

/** One plan task split over several repos: its parts, and one button that merges them in order once all are ready. */
export function GroupBar({ group, tasks, notice, busy, onMerge }) {
  const parts = group.tasks.map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
  return (
    <p className="core-tasks-group" role="group" aria-label={`${group.tasks.join(" and ")} merge together`}>
      <strong>{parts.map((t) => `${t.id} (${t.repo})`).join(" + ")}</strong>
      <span className="core-muted">{group.done ? " merged" : group.ready ? " all ready" : " not all ready yet"}</span>
      {!group.done && <button type="button" className="core-button primary" disabled={!group.ready || busy} onClick={() => onMerge(group)}>Merge together</button>}
      {notice && <span className={`core-tasks-notice ${notice.tone}`}>{notice.text}</span>}
    </p>
  );
}

function Amount({ row }) {
  if (!row.calls) return <span className="core-muted">no usage reported</span>;
  const parts = [["reported by the agent", row.reportedUsd], ["measured (Jev)", row.measuredUsd], ["estimated from your prices", row.estimatedUsd]].filter(([, v]) => v > 0);
  return (
    <span>
      {row.usd > 0 ? <strong>{usd(row.usd)}</strong> : <strong>no dollar figure</strong>}{" "}
      <span className="core-muted">
        {parts.map(([label, v]) => `${usd(v)} ${label}`).join(" · ")}
        {row.unpricedTokens > 0 ? `${parts.length ? " · " : ""}${kilo(row.unpricedTokens)} tokens with no price` : ""}
        {` · ${kilo(row.inputTokens)} in / ${kilo(row.outputTokens)} out`}
      </span>
    </span>
  );
}

function Prices({ prices, onSave }) {
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const form = useForm(async () => {
    await onSave({ ...prices, [model.trim()]: { inputPerMillion: Number(input), outputPerMillion: Number(output) } });
    setModel(""); setInput(""); setOutput("");
  });
  return (
    <form onSubmit={form.run} aria-label="Your prices per million tokens">
      <label>Model<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-4-5" autoComplete="off" /></label>
      <label>$ per million in<input inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} /></label>
      <label>$ per million out<input inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} /></label>
      <button type="submit" className="core-button" disabled={!model.trim() || input === "" || output === "" || form.busy}>Save price</button>
      {form.error && <p className="core-tasks-warn" role="alert">{form.error.message}</p>}
      {Object.keys(prices).length > 0 && <p className="core-muted">Your prices: {Object.entries(prices).map(([m, p]) => `${m} $${p.inputPerMillion} in / $${p.outputPerMillion} out`).join(" · ")}</p>}
    </form>
  );
}

export function CostPanel() {
  const resource = useCoreResource("/cost", { pollMs: 8000 });
  const data = resource.data;
  if (!data) return null;
  const savePrices = (prices) => resource.post("/cost/prices", prices);
  return (
    <details className="core-card core-tasks-cost">
      <summary>Cost: {data.project.calls ? (data.project.usd > 0 ? usd(data.project.usd) : "no dollar figure yet") : "no usage reported yet"}</summary>
      <p className="core-muted">Agents report their own usage, so those numbers are not checked. Only Jev's review cost is measured. Tokens turn into dollars only with a price you set below.</p>
      <p><Amount row={data.project} /></p>
      {data.byRepo.length > 1 && <ul>{data.byRepo.map((r) => <li key={r.key}><strong>{r.key}</strong> <Amount row={r} /></li>)}</ul>}
      {data.byTask.length > 0 && (
        <ul>
          {data.byTask.map((t) => (
            <li key={t.key}>
              <strong>{t.key}</strong> {data.byRepo.length > 1 && <span className="core-muted">({t.repo}) </span>}<Amount row={t} />
              {t.runs.length > 1 && <ul>{t.runs.map((r) => <li key={r.key}>{r.task} · {r.worker} · {r.model}: <Amount row={r} /></li>)}</ul>}
            </li>
          ))}
        </ul>
      )}
      {data.ignored > 0 && <p className="core-tasks-warn">{data.ignored} usage line{data.ignored === 1 ? "" : "s"} with impossible numbers {data.ignored === 1 ? "was" : "were"} left out.</p>}
      <Prices prices={data.prices} onSave={savePrices} />
    </details>
  );
}

