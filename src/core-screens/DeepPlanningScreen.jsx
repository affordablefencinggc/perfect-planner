import { useId, useRef, useState } from "react";
import {
  CheckCircleIcon,
  FlagIcon,
  LightbulbIcon,
  ListChecksIcon,
  SealCheckIcon,
  TreeStructureIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { AdvancedOnly, ConfidenceMeter, CoreError, CoreLoading, CoreScreen, useAdvanced } from "./CoreScreen.jsx";
import ContractDetails from "./ContractDetails.jsx";
import { useCoreResource } from "./coreApi.js";
import "./DeepPlanningScreen.css";

// Deep planning: the hard questions first. Reads /api/core/planning (see
// core/host/routes/planning.ts). Every answer is a ledger entry; "TBD" and
// "later" are refused by the deferral catcher, and approval waits for every
// blocking question. What the person's own idea settles ("no accounts") is
// shown as settled by their description and can be reopened; the roadmap
// takes tasks of their own and lets them leave draft tasks out.

const VIEWS = [
  { id: "questions", label: "Questions", Icon: ListChecksIcon },
  { id: "mindmap", label: "Mind map", Icon: TreeStructureIcon },
  { id: "roadmap", label: "Roadmap", Icon: FlagIcon },
];

const KIND_LABELS = { component: "Part", data: "Data", screen: "Screen", integration: "Service", risk: "Risk" };

function optionLabel(question, optionId) {
  return question.options.find((o) => o.id === optionId)?.label ?? optionId;
}

function today(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export default function DeepPlanningScreen() {
  const resource = useCoreResource("/planning", { isEmpty: (data) => !data?.started });
  const [view, setView] = useState("questions");
  const data = resource.data;

  return (
    <CoreScreen
      id="planning"
      title="Deep planning"
      purpose="Settle the decisions that sink projects when they come late, before any code is written. Every answer is recorded, and the plan can only be approved once the blocking questions are settled."
      resource={resource}
      empty={<IdeaStart resource={resource} />}
    >
      {data && (
        <>
          <ProgressHeader data={data} />
          <ApprovePanel data={data} resource={resource} />
          <TemplateBar data={data} resource={resource} />
          <BlockersRail data={data} onOpen={() => setView("questions")} />
          <ViewSwitch view={view} onChange={setView} />
          <div role="tabpanel" id={`planning-panel-${view}`} aria-labelledby={`planning-tab-${view}`} className="planning-panel">
            {view === "questions" && <QuestionPacks data={data} resource={resource} />}
            {view === "mindmap" && <MindMapView />}
            {view === "roadmap" && <RoadmapView />}
          </div>
        </>
      )}
    </CoreScreen>
  );
}

// ---------- Start ----------

function IdeaStart({ resource }) {
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [template, setTemplate] = useState("blank");
  const id = useId();
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resource.post("/planning/start", { idea, ...(template === "blank" ? {} : { template }) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="planning-start" onSubmit={submit}>
      <LightbulbIcon aria-hidden="true" className="planning-start-icon" />
      <strong>Start with your idea</strong>
      <p>Describe what you want to build in a sentence or two. Perfect Planner turns it into the questions that need an answer before any code is written, with a recommendation for each.</p>
      <label htmlFor={`${id}-idea`} className="planning-label">Your idea</label>
      <textarea
        id={`${id}-idea`}
        rows={3}
        value={idea}
        onChange={(e) => setIdea(e.target.value)}
        placeholder="For example: a desktop invoice app with Stripe payments that works offline"
      />
      <TemplatePicker value={template} onChange={setTemplate} />
      <p className="core-muted planning-note">Recommendations come from built-in question packs. Live web research is off because it needs a research key, so no sources are attached yet.</p>
      {error && <p className="planning-refusal" role="alert">{error}</p>}
      <button type="submit" className="core-button primary" disabled={busy || idea.trim().length < 3}>
        {busy ? "Starting…" : "Start planning"}
      </button>
    </form>
  );
}

// ---------- Starter templates (core/planning/templates.ts, listed by GET /planning/templates) ----------
// A starter only suggests. It answers nothing and approves nothing. No list, no picker.

function TemplatePicker({ value, onChange }) {
  const list = useCoreResource("/planning/templates");
  const id = useId();
  if (list.status !== "ready") return null;
  const options = [{ id: "blank", title: "Start blank", description: list.data.blank.description }, ...list.data.templates];
  return (
    <fieldset className="planning-templates">
      <legend className="planning-label">What kind of work is this? (optional)</legend>
      <div className="planning-template-list">
        {options.map((t) => (
          <label key={t.id} className={`planning-template${value === t.id ? " is-chosen" : ""}`}>
            <input type="radio" name={`${id}-template`} value={t.id} checked={value === t.id} onChange={() => onChange(t.id)} />
            <strong>{t.title}</strong>
            <span className="core-muted">{t.description}</span>
          </label>
        ))}
      </div>
      <p className="core-muted planning-note">{list.data.note}</p>
    </fieldset>
  );
}

function TemplateBar({ data, resource }) {
  const list = useCoreResource("/planning/templates");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const id = useId();
  if (list.status !== "ready") return null;
  const t = data.template;
  const locked = data.approval.approved.length > 0; // the roadmap is on the board: the starter is fixed
  const act = async (path, body) => {
    setBusy(true);
    setRefusal(null);
    try {
      await resource.post(path, body);
    } catch (e) {
      setRefusal(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="core-card planning-template-bar" aria-label="Starter template">
      <label htmlFor={`${id}-starter`} className="planning-label">Starter</label>
      <select id={`${id}-starter`} value={t?.id ?? "blank"} disabled={busy || locked} onChange={(e) => act("/planning/template", { template: e.target.value })}>
        <option value="blank">Start blank</option>
        {list.data.templates.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
      </select>
      {t && <span className="core-muted">{t.description} {locked ? "The plan is approved, so the starter is fixed." : "Your answers are kept if you change it."}</span>}
      {!locked && t?.skippable > 0 && (
        <button type="button" className="core-button" disabled={busy} onClick={() => act("/planning/template/skip", {})}>
          Mark {t.skippable === 1 ? "1 question" : `${t.skippable} questions`} as not needed ({t.usuallySkip.map((a) => a.title).join(", ")})
        </button>
      )}
      {refusal && <p className="planning-refusal" role="alert">{refusal}</p>}
    </section>
  );
}

// ---------- Header, approval, blockers ----------

function ProgressHeader({ data }) {
  const { answered, total, blockingOpen } = data.progress;
  const pct = total ? Math.round((answered / total) * 100) : 0;
  return (
    <div className="core-card planning-progress" aria-label="Planning progress">
      <div className="planning-idea">
        <span className="core-muted">Your idea</span>
        <p>{data.idea ?? "Your idea"}</p>
        <AdvancedOnly>signals: {data.signals.length ? data.signals.join(", ") : "none"} · asked as {data.person}</AdvancedOnly>
      </div>
      <div className="planning-stats">
        <div>
          <strong>{answered} of {total}</strong>
          <span className="core-muted">questions answered</span>
          <span className="planning-bar" role="progressbar" aria-label="Questions answered" aria-valuemin={0} aria-valuemax={total} aria-valuenow={answered}>
            <span style={{ width: `${pct}%` }} />
          </span>
        </div>
        <div>
          <strong className={blockingOpen ? "planning-warn" : "planning-good"}>{blockingOpen}</strong>
          <span className="core-muted">{blockingOpen === 1 ? "blocking question open" : "blocking questions open"}</span>
        </div>
      </div>
      <p className="core-muted planning-note">{data.research.note}</p>
    </div>
  );
}

function ApprovePanel({ data, resource }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [done, setDone] = useState(null);
  const [acceptedFor, setAcceptedFor] = useState(null);
  const approved = data.approval.approved;
  const latest = approved[approved.length - 1];
  // Tasks the plan marks "split this" are approved only when the person ticks that they read them.
  const flagged = data.approval.flagged ?? [];
  const accepted = acceptedFor === data.fingerprint;
  const approve = async () => {
    setBusy(true);
    setRefusal(null);
    setDone(null);
    try {
      const result = await resource.post("/planning/approve", { fingerprint: data.fingerprint, ...(flagged.length ? { acceptFlagged: flagged.map((f) => f.key) } : {}) });
      const count = Object.keys(result.tasks ?? {}).length;
      setDone(count ? `Plan approved. ${count} roadmap tasks were added.` : "The changed plan is approved. The roadmap tasks were already added.");
    } catch (e) {
      setRefusal(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`planning-approve ${data.approval.canApprove ? "is-ready" : "is-blocked"}`}>
      <div>
        <strong>{latest ? "Plan approved" : data.approval.canApprove ? "Ready to approve" : "Not ready to approve"}</strong>
        {!refusal && <p>{data.approval.message}</p>}
        {latest && (
          <p className="core-muted">
            Last approved {new Date(latest.at).toLocaleString()} by {latest.by}. <AdvancedOnly>{latest.plan} · {latest.entry}</AdvancedOnly>
          </p>
        )}
        {flagged.length > 0 && !(data.approval.current ?? data.approval.upToDate) && (
          <div className="planning-flagged">
            <p><strong>{flagged.length === 1 ? "1 task needs a closer look" : `${flagged.length} tasks need a closer look`}</strong> before the plan is approved:</p>
            <ul>{flagged.map((f) => <li key={f.key}><strong>{f.title}.</strong> {f.flags.map((x) => x.message).join(" ")}</li>)}</ul>
            <label><input type="checkbox" checked={accepted} onChange={(e) => setAcceptedFor(e.target.checked ? data.fingerprint : null)} /> I have read {flagged.length === 1 ? "this" : "these"} and accept {flagged.length === 1 ? "it" : "them"} as {flagged.length === 1 ? "it is" : "they are"}</label>
          </div>
        )}
        {refusal && <p className="planning-refusal" role="alert">{refusal}</p>}
        {done && <p className="planning-done" role="status">{done}</p>}
      </div>
      <button type="button" className="core-button primary" onClick={approve} disabled={busy || (data.approval.current ?? data.approval.upToDate) || (flagged.length > 0 && !accepted)}>
        <SealCheckIcon aria-hidden="true" /> {busy ? "Approving…" : (data.approval.current ?? data.approval.upToDate) ? "Plan approved" : latest ? "Approve changed plan" : "Approve plan"}
      </button>
    </div>
  );
}

function BlockersRail({ data, onOpen }) {
  if (!data.blockers.length) {
    return (
      <p className="planning-rail-clear" role="status"><CheckCircleIcon aria-hidden="true" weight="fill" /> No blocking questions are open.</p>
    );
  }
  const jump = (q) => {
    onOpen();
    requestAnimationFrame(() => {
      const card = document.getElementById(`planning-q-${q}`);
      card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      card?.focus?.({ preventScroll: true });
    });
  };
  return (
    <section className="planning-rail" aria-labelledby="planning-rail-title">
      <h3 id="planning-rail-title"><WarningIcon aria-hidden="true" weight="fill" /> Open blocking questions</h3>
      <ul>
        {data.blockers.map((b) => (
          <li key={b.q}>
            <span className="planning-rail-area">{b.areaTitle}</span>
            <span className="planning-rail-text">{b.text}</span>
            <AdvancedOnly>{b.q} · {b.id}</AdvancedOnly>
            <button type="button" className="core-button" onClick={() => jump(b.q)} aria-label={`Go to question: ${b.text}`}>Go to question</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ViewSwitch({ view, onChange }) {
  const refs = useRef({});
  const onKey = (event) => {
    const i = VIEWS.findIndex((v) => v.id === view);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = VIEWS[(i + step + VIEWS.length) % VIEWS.length].id;
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="planning-tabs" role="tablist" aria-label="Planning views" onKeyDown={onKey}>
      {VIEWS.map(({ id, label, Icon }) => (
        <button
          key={id}
          ref={(el) => { refs.current[id] = el; }}
          type="button"
          role="tab"
          id={`planning-tab-${id}`}
          aria-selected={view === id}
          aria-controls={`planning-panel-${id}`}
          tabIndex={view === id ? 0 : -1}
          className={view === id ? "is-active" : ""}
          onClick={() => onChange(id)}
        >
          <Icon aria-hidden="true" /> {label}
        </button>
      ))}
    </div>
  );
}

// ---------- Questions ----------

function QuestionPacks({ data, resource }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const confident = data.areas.flatMap((a) => a.questions).filter((q) => q.status === "open" && q.recommendation.option && q.recommendation.confidence >= 0.75).length;
  const acceptAll = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await resource.post("/planning/accept", { minConfidence: 0.75 });
      setNote(`${result.decided.length} recommendations taken.`);
    } catch (e) {
      setNote(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="planning-packs">
      {confident > 0 && (
        <div className="planning-accept-all">
          <p>{confident === 1 ? "1 open question has" : `${confident} open questions have`} a confident recommendation (75% or more).</p>
          <button type="button" className="core-button" onClick={acceptAll} disabled={busy}>Use all confident recommendations</button>
        </div>
      )}
      {note && <p className="core-muted" role="status">{note}</p>}
      <DescriptionPanel data={data} resource={resource} />
      {data.areas.map((area) => {
        const open = area.questions.filter((q) => q.status === "open").length;
        return (
          <section key={area.area} className="planning-pack" aria-labelledby={`planning-pack-${area.area}`}>
            <header>
              <h3 id={`planning-pack-${area.area}`}>{area.title}</h3>
              <span className={`core-pill ${open ? "" : "good"}`}>{open ? `${open} open` : "All answered"}</span>
              {area.hint && <span className="core-pill">{area.hint === "ask-first" ? "Start here" : "Usually not needed for this starter"}</span>}
            </header>
            <div className="planning-cards">
              {area.questions.map((q) => <QuestionCard key={q.q} question={q} resource={resource} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// What the person's own idea already settled ("No accounts" answers "Who
// signs in?"), so they can see why a question was skipped and answer it
// themselves instead.
function DescriptionPanel({ data, resource }) {
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const ruledOut = data.description?.ruledOut ?? [];
  const settled = data.description?.settled ?? [];
  if (!ruledOut.length && !settled.length) return null;
  const reopen = async (q) => {
    setBusy(q);
    setRefusal(null);
    try {
      await resource.post("/planning/reopen", { q });
    } catch (e) {
      setRefusal(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="core-card planning-described" aria-labelledby="planning-described-title">
      <h3 id="planning-described-title">{settled.some((s) => s.from === "repo") ? "Settled by your description and your repo" : "Settled by your description"}</h3>
      <p className="core-muted">{settled.some((s) => s.from === "repo") ? "Your idea and the code already answer these, so they were not asked." : "Your idea already answers these, so they were not asked."} If one is wrong, answer it yourself.</p>
      {ruledOut.length > 0 && (
        <ul className="planning-ruled-out" aria-label="What your idea rules out">
          {ruledOut.map((r) => (
            <li key={r.id}><span className="core-pill">{r.label}</span> <span className="core-muted">“{r.phrase}”</span></li>
          ))}
        </ul>
      )}
      {settled.length > 0 && (
        <ul className="planning-settled">
          {settled.map((s) => (
            <li key={s.q}>
              <span className="planning-rail-area">{s.areaTitle}</span>
              <span>{s.text}</span>
              <strong>{s.answer}</strong>
              <span className="core-muted">{s.from === "repo" ? "Your repo already has this." : `You wrote “${s.phrase}”.`}</span>
              <AdvancedOnly>{s.q} · {s.id}{s.decision ? ` · ${s.decision}` : ""}</AdvancedOnly>
              <button type="button" className="core-button" disabled={busy !== null} onClick={() => reopen(s.q)} aria-label={`Answer it myself: ${s.text}`}>
                {busy === s.q ? "Reopening…" : "Answer it myself"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {refusal && <p className="planning-refusal" role="alert">{refusal}</p>}
    </section>
  );
}

function QuestionCard({ question, resource }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [freeText, setFreeText] = useState("");
  const [spikeOpen, setSpikeOpen] = useState(false);
  const [due, setDue] = useState(today(7));
  const [risk, setRisk] = useState("");
  const id = useId();
  const rec = question.recommendation;
  const open = question.status === "open";

  const send = async (body) => {
    setBusy(true);
    setRefusal(null);
    try {
      await resource.post("/planning/answer", { q: question.q, ...body });
      setFreeText("");
      setSpikeOpen(false);
    } catch (e) {
      setRefusal(e.message);
      if (e.code === "DEFERRED") setSpikeOpen(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article id={`planning-q-${question.q}`} tabIndex={-1} className={`core-card planning-card is-${question.status}`} aria-labelledby={`${id}-text`}>
      <div className="planning-card-head">
        {question.blocking ? <span className="core-pill warn">Blocking</span> : <span className="core-pill">Nice to know</span>}
        {question.status === "decided" && <span className="core-pill good">Decided</span>}
        {question.status === "spiked" && <span className="core-pill warn">Spike set</span>}
        {question.source === "description" && <span className="core-pill">From your description</span>}
        {question.source === "repo" && <span className="core-pill">From your repo</span>}
        <AdvancedOnly>{question.q} · {question.id}{question.entries?.asked ? ` · asked ${question.entries.asked}` : ""}</AdvancedOnly>
      </div>
      <h4 id={`${id}-text`}>{question.text}</h4>
      {question.why && <p className="core-muted planning-why">{question.why}</p>}

      {!open && (
        <div className="planning-answer">
          <span className="core-muted">Answer</span>
          <p>{question.answer}</p>
          {question.spike && <p className="core-muted">Decide by {question.spike.due}. Risk: {question.spike.risk}</p>}
          <AdvancedOnly as="p">
            {[question.decision, question.spike?.task, question.entries?.decided, question.entries?.spike, question.entries?.answered && `answered ${question.entries.answered}`].filter(Boolean).join(" · ")}
          </AdvancedOnly>
        </div>
      )}

      {open && question.suggestion && (
        <div className="planning-suggestion">
          <span>Suggestion from the {question.suggestion.from} starter: <strong>{question.suggestion.label}</strong></span>
          <p>{question.suggestion.why} Nothing is decided until you use it.</p>
          <button type="button" className="core-button" disabled={busy} onClick={() => send(question.suggestion.option ? { choice: question.suggestion.option } : { text: question.suggestion.text })}>Use suggestion</button>
        </div>
      )}

      {rec?.option && (
        <div className="planning-rec">
          <div className="planning-rec-head">
            <span>Recommended: <strong>{optionLabel(question, rec.option)}</strong></span>
            <ConfidenceMeter value={rec.confidence} label="How sure the recommendation is" />
          </div>
          {rec.reason && <p>{rec.reason}</p>}
          {rec.sources?.length > 0 ? (
            <ul className="planning-sources">
              {rec.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a></li>)}
            </ul>
          ) : (
            <p className="core-muted planning-note">No research sources (live research is off).</p>
          )}
          {open && (
            <button type="button" className="core-button primary" disabled={busy} onClick={() => send({ choice: rec.option })}>
              <CheckCircleIcon aria-hidden="true" /> Use recommendation
            </button>
          )}
        </div>
      )}

      {open && (
        <>
          {question.options.filter((o) => o.id !== rec?.option).length > 0 && (
            <div className="planning-options" role="group" aria-label="Other options">
              <span className="core-muted">Other options</span>
              {question.options.filter((o) => o.id !== rec?.option).map((o) => (
                <button key={o.id} type="button" className="planning-option" disabled={busy} onClick={() => send({ choice: o.id })} aria-label={`Choose ${o.label}`}>
                  <strong>{o.label}</strong>
                  <span>{o.fit}</span>
                  {o.cost && <span className="core-muted">{o.cost}</span>}
                </button>
              ))}
            </div>
          )}
          <form className="planning-free" onSubmit={(e) => { e.preventDefault(); send({ text: freeText }); }}>
            <label htmlFor={`${id}-free`} className="planning-label">Your own answer</label>
            <div>
              <input id={`${id}-free`} value={freeText} onChange={(e) => setFreeText(e.target.value)} placeholder="Write the decision in your own words" />
              <button type="submit" className="core-button" disabled={busy || !freeText.trim()}>Save answer</button>
            </div>
          </form>
          {refusal && <p className="planning-refusal" role="alert">{refusal}</p>}
          {spikeOpen && (
            <form className="planning-spike" onSubmit={(e) => { e.preventDefault(); send({ text: freeText, spike: { due, risk } }); }}>
              <p>Can't decide yet? Set a dated spike: someone looks into it by a date (within 30 days), and you write down what goes wrong if it stays open.</p>
              <label htmlFor={`${id}-due`} className="planning-label">Decide by</label>
              <input id={`${id}-due`} type="date" value={due} min={today()} max={today(30)} onChange={(e) => setDue(e.target.value)} />
              <label htmlFor={`${id}-risk`} className="planning-label">Risk if it stays open</label>
              <input id={`${id}-risk`} value={risk} onChange={(e) => setRisk(e.target.value)} placeholder="For example: wrong tax handling blocks EU sales" />
              <button type="submit" className="core-button" disabled={busy || !risk.trim()}>Set spike</button>
            </form>
          )}
        </>
      )}
    </article>
  );
}

// ---------- Mind map ----------

function MindMapView() {
  const resource = useCoreResource("/planning/mindmap");
  if (resource.status === "loading") return <CoreLoading label="Loading the mind map" />;
  if (resource.status === "error") return <CoreError error={resource.error} onRetry={resource.reload} />;
  if (resource.status === "no-session") return null; // the screen shows the shared notice
  const { map, depth, answered } = resource.data;
  const root = map.nodes[map.root];
  return (
    <div className="planning-mindmap">
      {!answered && <p className="core-empty" role="status"><strong>No answers yet</strong>Answer a few questions and the parts of your app appear here.</p>}
      <div className="core-card planning-tree" aria-label="Mind map">
        <p className="planning-tree-root"><TreeStructureIcon aria-hidden="true" /> {root?.label}</p>
        {root && root.children.length > 0 && <MindChildren map={map} ids={root.children} seen={new Set([map.root])} />}
      </div>
      {depth.length > 0 && (
        <section className="core-card planning-depth" aria-labelledby="planning-depth-title">
          <h3 id="planning-depth-title">Worth a closer look</h3>
          <ul>
            {depth.map((f, i) => (
              <li key={i}>
                <span className={`core-pill ${f.kind === "contradiction" ? "bad" : "warn"}`}>{f.kind === "contradiction" ? "Answers disagree" : "Needs more detail"}</span> {f.message}
                <AdvancedOnly> {f.questions.join(", ")}</AdvancedOnly>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MindChildren({ map, ids, seen }) {
  const advanced = useAdvanced();
  return (
    <ul>
      {ids.map((id) => {
        const node = map.nodes[id];
        if (!node || seen.has(id)) return null;
        const next = new Set(seen).add(id);
        return (
          <li key={id} className={`planning-node is-${node.kind}`}>
            <span className="planning-node-label">
              <span className="planning-node-kind">{KIND_LABELS[node.kind] ?? node.kind}</span>
              {node.label}
              {advanced && <span className="core-advanced"> {node.id} · from {node.from.join(", ")}</span>}
            </span>
            {node.note && <span className="core-muted planning-node-note">{node.note}</span>}
            {node.children.length > 0 && <MindChildren map={map} ids={node.children} seen={next} />}
          </li>
        );
      })}
    </ul>
  );
}

// ---------- Roadmap ----------

function RoadmapView() {
  const resource = useCoreResource("/planning/roadmap");
  if (resource.status === "loading") return <CoreLoading label="Loading the roadmap" />;
  if (resource.status === "error") return <CoreError error={resource.error} onRetry={resource.reload} />;
  if (resource.status === "no-session") return null; // the screen shows the shared notice
  const { phases, written, answered } = resource.data;
  const dropped = resource.data.dropped ?? [];
  const existing = resource.data.existing ?? [];
  const template = resource.data.template;
  return (
    <div className="planning-roadmap">
      <p className="core-muted">
        {written ? "These tasks are on the board. They were added when the plan was approved." : "A draft. The tasks are added to the board when you approve the plan. Tasks you add yourself go on the board straight away."}
      </p>
      {existing.length > 0 && (
        <p className="core-muted planning-existing">Already in your repo, so no task: {existing.map((e) => e.label).join(", ")}.</p>
      )}
      {template && !written && (
        <p className="core-muted planning-existing">
          Tasks marked Suggested come from the {template.title} starter. They are added only when you approve the plan, and you can leave any of them out.
          {template.leftOut.length > 0 && ` Not suggested because of your idea: ${template.leftOut.map((x) => x.title).join(", ")}.`}
        </p>
      )}
      <RoadmapChanges resource={resource} />
      {!answered && !template && <p className="core-empty" role="status"><strong>No answers yet</strong>Only the release task exists until questions are answered.</p>}
      <ol className="planning-phases">
        {phases.map((phase) => (
          <li key={phase.id} className="core-card planning-phase">
            <h3>{phase.title} <span className="core-muted">({phase.tasks.length})</span></h3>
            {phase.tasks.length === 0 ? (
              <p className="core-muted">Nothing in this phase.</p>
            ) : (
              <ul>
                {phase.tasks.map((t) => (
                  <li key={t.key} className={`planning-task${t.own ? " is-own" : ""}`}>
                    <strong>{t.title} {t.own && <span className="core-pill">Your task</span>} {t.suggested && <span className="core-pill">Suggested</span>}</strong>
                    {t.doneWhen && <span className="core-muted">Done when {t.doneWhen}</span>}
                    <span className="core-muted">Owner: {t.owner}</span>
                    <AdvancedOnly as="span">
                      {t.task ?? t.key}{t.entry ? ` · ${t.entry}` : ""}{t.dependsOnTasks.length ? ` · after ${t.dependsOnTasks.join(", ")}` : ""}{t.template ? ` · ${t.template.size} · ${t.template.files.join(", ")}` : ""}
                    </AdvancedOnly>
                    {t.contract && (
                      <ContractDetails
                        contract={{
                          files: t.contract.allowedFiles,
                          sizeCap: t.contract.sizeCap,
                          clauses: t.contract.clauses,
                          warnings: [...(t.contractFlags ?? []).map((f) => f.message), ...(t.contractState && t.contractState.status !== "signed" ? [t.contractState.problem ?? "This contract is not the one you approved."] : [])],
                        }}
                      />
                    )}
                    {!written && !t.own && t.key !== FINAL_TASK_KEY && (
                      <RoadmapAction resource={resource} path="/planning/roadmap/drop" taskKey={t.key} label={`Leave out: ${t.title}`}>Leave out</RoadmapAction>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {dropped.length > 0 && (
        <section className="core-card planning-dropped" aria-labelledby="planning-dropped-title">
          <h3 id="planning-dropped-title">Left out of the roadmap</h3>
          <ul>
            {dropped.map((d) => (
              <li key={d.key} className="planning-task">
                <strong>{d.title}</strong>
                <AdvancedOnly as="span">{d.key} · {d.decision}</AdvancedOnly>
                {!written && <RoadmapAction resource={resource} path="/planning/roadmap/restore" taskKey={d.key} label={`Put back: ${d.title}`}>Put back</RoadmapAction>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Key of the release task that closes every roadmap; it cannot be left out. */
const FINAL_TASK_KEY = "K-first-release";

const PHASE_OPTIONS = [
  { id: "foundation", label: "Foundation" },
  { id: "core", label: "Core" },
  { id: "integrations", label: "Integrations" },
  { id: "hardening", label: "Hardening" },
  { id: "release", label: "Release" },
];

function RoadmapAction({ resource, path, taskKey, label, children }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const act = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await resource.post(path, { key: taskKey });
    } catch (e) {
      setRefusal(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="core-button planning-task-action" disabled={busy} onClick={act} aria-label={label}>{children}</button>
      {refusal && <span className="planning-refusal" role="alert">{refusal}</span>}
    </>
  );
}

// The person's own task: written straight to the ledger as a numbered task, so it is on the board now.
function RoadmapChanges({ resource }) {
  const [title, setTitle] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [phase, setPhase] = useState("core");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [done, setDone] = useState(null);
  const id = useId();
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    setDone(null);
    try {
      const result = await resource.post("/planning/tasks", { title: title.trim(), ...(doneWhen.trim() ? { doneWhen: doneWhen.trim() } : {}), phase });
      setDone(`“${title.trim()}” is on the task board.`);
      setTitle("");
      setDoneWhen("");
      return result;
    } catch (e) {
      setRefusal(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="core-card planning-own-task" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Add your own task</h3>
      <label htmlFor={`${id}-task`} className="planning-label">Task</label>
      <input id={`${id}-task`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="For example: export my habits to a CSV file" />
      <label htmlFor={`${id}-done`} className="planning-label">Done when (optional)</label>
      <input id={`${id}-done`} value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} placeholder="For example: a test exports three habits and reads them back" />
      <label htmlFor={`${id}-phase`} className="planning-label">Phase</label>
      <select id={`${id}-phase`} value={phase} onChange={(e) => setPhase(e.target.value)}>
        {PHASE_OPTIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {refusal && <p className="planning-refusal" role="alert">{refusal}</p>}
      {done && <p className="planning-done" role="status">{done}</p>}
      <button type="submit" className="core-button primary" disabled={busy || !title.trim()}>{busy ? "Adding…" : "Add task"}</button>
    </form>
  );
}
