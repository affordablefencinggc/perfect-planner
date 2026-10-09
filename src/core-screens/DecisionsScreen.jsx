import { useId, useState } from "react";
import { CaretRightIcon, CheckCircleIcon, PlusIcon, ScalesIcon, WarningIcon } from "@phosphor-icons/react";
import { AdvancedOnly, ConfidenceMeter, CoreScreen, useAdvanced } from "./CoreScreen.jsx";
import { useCoreResource } from "./coreApi.js";
import "./DecisionsScreen.css";

// Decisions: every call the project is waiting on, each with Jev's (or the
// offline reviewer's) recommendation, and every call already made. Reads
// GET /api/core/decisions; writes through /decisions/accept, /override, /ask.

const isEmpty = (data) => !data || ((data.open?.length ?? 0) === 0 && (data.decided?.length ?? 0) === 0);

const STATUS = {
  open: { label: "Waiting", tone: "warn" },
  accepted: { label: "Accepted", tone: "good" },
  overridden: { label: "Chose something else", tone: "" },
  decided: { label: "Decided", tone: "" },
};

function when(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function errorText(error) {
  return error?.message || "That did not save. Try again.";
}

export default function DecisionsScreen() {
  const resource = useCoreResource("/decisions", { isEmpty, pollMs: 10000 });
  const [asking, setAsking] = useState(false);
  const data = resource.data;
  const ask = (body) => resource.post("/decisions/ask", body);

  const empty = (
    <div className="decisions-empty">
      <strong>No decisions waiting.</strong>
      <p>When an agent or the plan needs a call, it lands here with Jev's recommendation.</p>
      {data?.jev && <JevNote jev={data.jev} />}
      <AskForm onAsk={ask} />
    </div>
  );

  return (
    <CoreScreen
      id="decisions"
      title="Decisions"
      purpose="Calls the project needs from you, each with a recommendation and the reasons for it."
      actions={resource.status === "ready" ? (
        <button type="button" className="core-button" aria-expanded={asking} onClick={() => setAsking((v) => !v)}>
          <PlusIcon aria-hidden="true" /> Ask for a decision
        </button>
      ) : null}
      resource={resource}
      empty={empty}
    >
      {data && (
        <>
          {asking && <AskForm onAsk={async (body) => { const r = await ask(body); setAsking(false); return r; }} onCancel={() => setAsking(false)} />}
          <Summary summary={data.summary} />
          <JevNote jev={data.jev} />
          <OpenSection cards={data.open} post={resource.post} />
          <DecidedSection cards={data.decided} />
        </>
      )}
    </CoreScreen>
  );
}

function JevNote({ jev }) {
  const advanced = useAdvanced();
  if (!jev) return null;
  if (jev.connected) {
    return advanced ? <p className="decisions-jev is-connected"><CheckCircleIcon aria-hidden="true" weight="fill" /> {jev.note} <span className="core-advanced">Model: {jev.model}</span></p> : null;
  }
  return (
    <p className="decisions-jev" role="note">
      <WarningIcon aria-hidden="true" weight="fill" /> {jev.note}
    </p>
  );
}

function Summary({ summary }) {
  if (!summary) return null;
  return (
    <dl className="decisions-summary" aria-label="Decisions summary">
      <div><dt>Waiting for you</dt><dd>{summary.open}</dd></div>
      <div><dt>Decided</dt><dd>{summary.decided}</dd></div>
      <div><dt>Spent on reviews this month</dt><dd>{summary.spend?.label ?? "$0.00"}</dd></div>
    </dl>
  );
}

function OpenSection({ cards, post }) {
  if (!cards?.length) return <p className="core-muted decisions-none">Nothing is waiting for you right now.</p>;
  return (
    <section className="decisions-open" aria-labelledby="decisions-open-title">
      <h3 id="decisions-open-title">Waiting for you ({cards.length})</h3>
      <ul className="decisions-list">
        {cards.map((card) => <li key={card.id}><OpenCard card={card} post={post} /></li>)}
      </ul>
    </section>
  );
}

function Chips({ rec, cost }) {
  const money = rec?.cost ?? cost;
  return (
    <div className="decisions-chips">
      {rec && (
        <span className="core-pill" title="Who made this recommendation">
          {rec.model ? `${rec.producedBy} · ${rec.model}` : `${rec.producedBy} · no model`}
        </span>
      )}
      <span className="core-pill" title="What this recommendation cost">{money ? `Cost ${money.label}` : "No cost"}</span>
    </div>
  );
}

function Recommendation({ rec, headingId }) {
  return (
    <div className="decisions-rec" aria-labelledby={headingId}>
      <div className="decisions-rec-head">
        <span id={headingId} className="decisions-rec-label">Recommendation</span>
        <strong className="decisions-rec-option">{rec.option}</strong>
        <ConfidenceMeter value={rec.confidence} label={`Confidence in ${rec.option}`} />
      </div>
      {rec.reasons?.length > 0 && (
        <div className="decisions-why">
          <span className="decisions-why-label">Why</span>
          <ul>{rec.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Numbers({ card }) {
  return (
    <AdvancedOnly as="p" className="decisions-numbers">
      {[card.q, card.d, card.task && `task ${card.task}`].filter(Boolean).join(" · ")}
      {card.entries?.length > 0 && <> · {card.entries.map((e) => `${e.n} #${e.hash}`).join(", ")}</>}
      {card.recommendation?.entry && <> · recommendation {card.recommendation.entry}</>}
    </AdvancedOnly>
  );
}

function OpenCard({ card, post }) {
  const id = useId();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const rec = card.recommendation;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try { await post("/decisions/accept", { q: card.q }); } catch (e) { setError(errorText(e)); setBusy(false); }
  };

  return (
    <article className="core-card decisions-card" aria-labelledby={`${id}-title`}>
      <header className="decisions-card-head">
        <h4 id={`${id}-title`}>{card.title}</h4>
        <div className="decisions-card-tags">
          {card.blocking && <span className="core-pill bad">Holding up work</span>}
          {card.planning && <span className="core-pill">From planning</span>}
        </div>
      </header>
      {card.askedBy && <p className="core-muted decisions-asked">Asked by {card.askedBy.name}, {when(card.askedAt)}</p>}
      {rec ? <Recommendation rec={rec} headingId={`${id}-rec`} /> : <p className="decisions-norec">{card.noRecommendation || "There is no recommendation for this one, so the call is yours."}</p>}
      <Chips rec={rec} cost={card.cost} />
      <Numbers card={card} />
      {error && <p className="decisions-error" role="alert">{error}</p>}
      <div className="decisions-card-actions">
        {rec && (
          <button type="button" className="core-button primary" disabled={busy} onClick={accept} aria-describedby={`${id}-title`}>
            <CheckCircleIcon aria-hidden="true" /> Accept recommendation
          </button>
        )}
        <button type="button" className="core-button" aria-expanded={choosing} aria-controls={`${id}-choose`} onClick={() => setChoosing((v) => !v)} disabled={busy}>
          {rec ? "Choose something else" : "Decide"}
        </button>
      </div>
      {choosing && <ChooseForm id={`${id}-choose`} card={card} post={post} onBusy={setBusy} />}
    </article>
  );
}

const OTHER = "__other__";

function ChooseForm({ id, card, post, onBusy }) {
  const recId = card.recommendation?.optionId;
  const first = card.options.find((o) => o.id !== recId)?.id ?? (card.options.length ? card.options[0].id : OTHER);
  const [choice, setChoice] = useState(card.options.length ? first : OTHER);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!reason.trim()) return setError("Say why. The reason is kept with the decision.");
    if (choice === OTHER && !text.trim()) return setError("Write your answer, or pick one of the options.");
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      await post("/decisions/override", { q: card.q, ...(choice === OTHER ? { text } : { choice }), reason });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
      onBusy(false);
    }
  };

  return (
    <form id={id} className="decisions-choose" onSubmit={submit} noValidate>
      <fieldset>
        <legend>Your decision</legend>
        {card.options.map((o) => (
          <label key={o.id} className="decisions-radio">
            <input type="radio" name={`${id}-choice`} value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} />
            {o.label}{o.id === recId && <span className="core-muted"> (recommended)</span>}
          </label>
        ))}
        <label className="decisions-radio">
          <input type="radio" name={`${id}-choice`} value={OTHER} checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
          Something else
        </label>
        {choice === OTHER && (
          <label className="decisions-field">
            <span>Your answer</span>
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
      </fieldset>
      <label className="decisions-field">
        <span>Why (required)</span>
        <textarea rows={2} value={reason} required aria-required="true" onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p className="decisions-error" role="alert">{error}</p>}
      <div className="decisions-card-actions">
        <button type="submit" className="core-button primary" disabled={busy}>Save decision</button>
      </div>
    </form>
  );
}

function DecidedSection({ cards }) {
  if (!cards?.length) return null;
  return (
    <details className="decisions-decided">
      <summary><CaretRightIcon aria-hidden="true" className="decisions-caret" /> Decided ({cards.length})</summary>
      <ul className="decisions-list">
        {cards.map((card) => <li key={card.id}><DecidedCard card={card} /></li>)}
      </ul>
    </details>
  );
}

function DecidedCard({ card }) {
  const id = useId();
  const status = STATUS[card.status] ?? STATUS.decided;
  const rec = card.recommendation;
  const out = card.outcome;
  return (
    <article className="core-card decisions-card is-decided" aria-labelledby={`${id}-title`}>
      <header className="decisions-card-head">
        <h4 id={`${id}-title`}>{card.title}</h4>
        <div className="decisions-card-tags">
          <span className={`core-pill ${status.tone}`.trim()}>{status.label}</span>
          {card.topic && <span className="core-pill">{card.topic === "people" ? "People" : card.topic === "budget" ? "Budget" : card.topic}</span>}
          {card.kind === "review" && <span className="core-pill">Review</span>}
        </div>
      </header>
      {out && (
        <div className="decisions-outcome">
          <p><span className="decisions-why-label">Decision</span> <strong>{out.answer}</strong></p>
          {out.reason && <p className="core-muted">{out.reason}</p>}
          {out.via && <p className="core-muted">{out.via}</p>}
          <p className="core-muted">By {out.by?.name ?? "someone"}, {when(out.at)}</p>
        </div>
      )}
      {rec && card.kind === "question" && (
        <p className="core-muted decisions-was">Recommended: {rec.option} ({Math.round((rec.confidence ?? 0) * 100)}% sure)</p>
      )}
      {rec && card.kind === "review" && rec.reasons?.length > 0 && (
        <ul className="decisions-review-notes">{rec.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      )}
      {(rec || card.cost) && <Chips rec={rec} cost={card.cost} />}
      <Numbers card={card} />
    </article>
  );
}

function AskForm({ onAsk, onCancel }) {
  const id = useId();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [blocking, setBlocking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const setOption = (i, value) => setOptions((list) => list.map((o, j) => (j === i ? value : o)));

  const submit = async (event) => {
    event.preventDefault();
    if (!question.trim()) return setError("Write the question you want decided.");
    setBusy(true);
    setError(null);
    try {
      const result = await onAsk({ question, options: options.map((o) => o.trim()).filter(Boolean), blocking });
      setQuestion("");
      setOptions(["", ""]);
      setBlocking(false);
      setDone(result?.status === "answered" ? `Already decided earlier: ${result.answer}` : null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="core-card decisions-ask" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
      <h3 id={`${id}-title`}><ScalesIcon aria-hidden="true" /> Ask for a decision</h3>
      <p className="core-muted">Write the question and the options you are weighing. It gets a number and a recommendation, then waits here for you.</p>
      <label className="decisions-field">
        <span>Question</span>
        <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} />
      </label>
      {options.map((o, i) => (
        <label key={i} className="decisions-field">
          <span>Option {i + 1}</span>
          <input type="text" value={o} onChange={(e) => setOption(i, e.target.value)} maxLength={200} />
        </label>
      ))}
      <div className="decisions-ask-row">
        {options.length < 8 && (
          <button type="button" className="core-button" onClick={() => setOptions((list) => [...list, ""])}>
            <PlusIcon aria-hidden="true" /> Add another option
          </button>
        )}
        <label className="decisions-check">
          <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} /> Work should wait for this
        </label>
      </div>
      {error && <p className="decisions-error" role="alert">{error}</p>}
      {done && <p className="decisions-done" role="status">{done}</p>}
      <div className="decisions-card-actions">
        <button type="submit" className="core-button primary" disabled={busy}>Raise this decision</button>
        {onCancel && <button type="button" className="core-button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
